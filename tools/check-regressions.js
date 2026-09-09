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
    name: "CNAME exists and still says factbox.app",
    why: "GitHub Pages binds a custom domain ONLY while a CNAME file sits at " +
         "the root of the published branch. Without it the domain is not " +
         "attached to the site at all: every URL serves GitHub's \"There " +
         "isn't a GitHub Pages site here\" page. That is the whole site down, " +
         "not one broken route, and nothing else in the repo hints that the " +
         "file matters. It was deleted once by a `git add -A` that swept up a " +
         "deletion nobody had looked at, and the site was dark until someone " +
         "opened it in a browser.",
    pass: () => {
      const p = path.join(ROOT, "CNAME");
      if (!fs.existsSync(p)) return "CNAME is missing — the custom domain will not bind";
      const v = fs.readFileSync(p, "utf8").trim();
      if (v !== "factbox.app") return `CNAME says "${v}", expected "factbox.app"`;
      return true;
    },
  },
  {
    name: "every hideable class ships its own [hidden] twin",
    why: "An author rule setting `display:` beats the user agent's " +
         "`[hidden]{display:none}` — author sheets outrank UA before " +
         "specificity is consulted. So `el.hidden = true` changes an " +
         "attribute and nothing else, and the element stays on screen. " +
         "This family has hit .ob, .au-link, .au-2nd, .sb-fan, .sb-fact " +
         "and .row. A node.hidden assertion passes the whole time; only a " +
         "rendered check or a screenshot catches it.",
    pass: () => {
      /* Every class that (a) sets a display and (b) is used in markup on an
         element carrying the hidden attribute, must have a [hidden] rule. */
      const sheets = fs.readdirSync(path.join(ROOT, "css"))
        .filter((f) => f.endsWith(".css")).map((f) => "css/" + f);
      const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
      const sets = (s) => {
        const out = new Set();
        const re = /(^|[},])\s*([^{}@]*?)\{([^}]*)\}/g;
        let m;
        while ((m = re.exec(s))) {
          /* A rule whose display IS none cannot leak — that is the safe
             pattern (.sp-sent ships display:none and is revealed by a
             sibling rule). Only a visible display beats the UA sheet. */
          const dm = m[3].match(/(?:^|[;\s])display\s*:\s*([a-z-]+)/);
          if (!dm || dm[1] === "none") continue;
          /* Only the SUBJECT of each selector — its last compound. A rule
             like `.sp-sent b{display:block}` styles the <b>, not .sp-sent,
             and crediting the ancestor produces false positives. Commas
             split alternatives; whitespace and combinators split compounds. */
          m[2].split(",").forEach((sel) => {
            const last = sel.trim().split(/[\s>+~]+/).filter(Boolean).pop() || "";
            (last.match(/\.[a-zA-Z][\w-]*/g) || []).forEach((c) => out.add(c.slice(1)));
          });
        }
        return out;
      };
      let display = new Set(), guarded = new Set();
      for (const f of sheets.concat(pages)) {
        const src = read(f);
        sets(src).forEach((c) => display.add(c));
        (src.match(/\.([a-zA-Z][\w-]*)\[hidden\]/g) || [])
          .forEach((c) => guarded.add(c.slice(1).replace("[hidden]", "")));
      }
      const risky = new Set();
      for (const f of pages) {
        const tags = read(f).match(/<[a-zA-Z][^>]*\bhidden\b[^>]*>/g) || [];
        for (const t of tags) {
          const cm = t.match(/class="([^"]*)"/);
          if (cm) cm[1].split(/\s+/).filter(Boolean).forEach((c) => risky.add(c));
        }
      }
      const bad = [...risky].filter((c) => display.has(c) && !guarded.has(c));
      return bad.length ? `no [hidden] twin for: ${bad.sort().join(", ")}` : true;
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
    name: "today's story is free to everyone, and the server is what says so",
    why: "js/access.js answers three ways — access, permanently free, or " +
         "today's Factbox — and asking FB.unlocked() alone puts a paywall in " +
         "front of the one story that is deliberately open to everybody, " +
         "every day. The reader page used to answer it with FBX.canRead(id): " +
         "the browser's own clock deciding whether to draw text the browser " +
         "had already downloaded, so moving a device clock moved which story " +
         "was free. There is no downloaded text to gate now. " +
         "functions/story.js works today's story out from the SERVER's clock " +
         "and either sends the cards or refuses, so the invariant here is the " +
         "opposite one: the reader must NOT re-decide, it must draw whatever " +
         "arrives and draw the wall only on a refusal.",
    pass: () => {
      const r = read("read.html"), g = read("js/gate.js");
      if (!/STORY_FN/.test(g) || !/Authorization/.test(g)) {
        return "js/gate.js no longer asks functions/story.js with a token";
      }
      if (!/meta\.free === true/.test(g)) {
        return "js/gate.js no longer routes on the permanently-free flag, so " +
               "either paid text is being fetched statically or today's free " +
               "story is being decided in the browser again";
      }
      if (!/e\.locked/.test(r) || !/wallFromCatalogue/.test(r)) {
        return "read.html no longer tells a refusal apart from a failure";
      }
      if (!/FBX\.isToday/.test(read("js/recommend.js"))) {
        return "js/recommend.js stopped knowing about today's story";
      }
      return true;
    },
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
    name: "nothing claims every card is sourced unless every card is",
    why: "The meta description on story/cleopatra/firststory told Google and " +
         "every link preview 'every card sourced'. Story 01 — the story those " +
         "three pages actually serve — has ten cards and zero with a src. " +
         "Across the catalogue it is 20 of 450. The artwork credit (cr) IS on " +
         "all 450, so 'every painting credited' is the true version of the " +
         "same trust signal. This check reads the data rather than trusting a " +
         "memory of it, because the claim becomes true the day somebody fills " +
         "the field in and should not need a code change then.",
    pass: () => {
      const CLAIM = /every card sourced|sources on every card|each card carries its source/i;
      const files = ["story.html", "cleopatra.html", "firststory.html",
                     "scenes/shell.html", "tools/compose.py", "join.html", "read.html"];
      const claiming = files.filter((f) => CLAIM.test(read(f) || ""));
      if (!claiming.length) return true;

      let total = 0, sourced = 0;
      try {
        /* The corpus is the untracked build input at content/stacks.json now:
           data/ is published, and that file is every word of all 51 stories. */
        const d = JSON.parse(read("content/stacks.json") || "{}");
        const st = d.stacks || d;
        const list = Array.isArray(st) ? st : Object.keys(st).map((k) => st[k]);
        list.forEach((s) => (s.cards || []).forEach((c) => {
          total++;
          if (String(c.src || "").trim()) sourced++;
        }));
      } catch (e) { return "could not read content/stacks.json to check: " + e.message; }

      if (total && sourced === total) return true;   /* the claim came true */
      return claiming.join(", ") + " claim every card is sourced, but only " +
             sourced + " of " + total + " cards carry a src";
    },
  },
  {
    name: "the per-day price cluster does not reuse .jn-day",
    why: "`.jn-day` is the streak badge in css/account.css: a 46x46 tinted " +
         "tile with flex-direction:column. The per-day price was first built " +
         "on that same class name and silently inherited all of it — the " +
         "figures stacked vertically and overlapped the line below. Every " +
         "content assertion passed while it looked like that, because the " +
         "strings were all present and correctly labelled. Only a screenshot " +
         "caught it. Same family as the FBP global collision.",
    pass: () => {
      const s = read("join.html");
      if (!s) return true;
      if (/class="jn-day(-|")/.test(s)) {
        return 'join.html builds a "jn-day" element again';
      }
      /* And the axis must be stated, not inherited. The inline style set
         display:flex but not flex-direction, so the stylesheet won that one
         property — which is the whole mechanism of the bug. */
      if (/jn-rate/.test(s) && !/flex-direction:row/.test(s)) {
        return "the price cluster no longer pins flex-direction:row";
      }
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
  {
    name: "no paid story's text ships as a static file",
    why: "This is the leak the whole gated read path was built to close. " +
         "data/stacks.json was 413KB of every word of all 51 stories, served " +
         "by GitHub Pages to anyone who typed the URL, and data/story/26.json " +
         "was one paid story on its own — no account, no token, no payment. " +
         "The realistic way it comes back is not a decision, it is a copy: " +
         "someone re-runs a build that writes the corpus back into data/, or " +
         "restores a file from an old branch because a fallback 404'd. So " +
         "this reads the data rather than the code. Paid text lives in " +
         "Firestore and leaves through functions/story.js, which checks the " +
         "reader; the only story files under data/ are the permanently free " +
         "ones, and data/index.json carries headlines and covers but no " +
         "card bodies.",
    pass: () => {
      const DATA = path.join(ROOT, "data");
      let index;
      try {
        index = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
      } catch (e) { return "data/index.json is unreadable: " + e.message; }
      const stacks = (index && index.stacks) || [];
      if (!stacks.length) return "data/index.json has no stacks";
      /* `=== true`, never truthy: this one test decides whether a story's
         text may be published. */
      const free = new Set(stacks.filter((s) => s.free === true).map((s) => String(s.id)));
      if (!free.size) return "data/index.json marks no story free — that cannot be right";

      /* 1 · the monolith, by name. It is the specific file that leaked. */
      if (fs.existsSync(path.join(DATA, "stacks.json"))) {
        return "data/stacks.json is back — that file is every word of all " +
               stacks.length + " stories, and data/ is published. The corpus " +
               "belongs at content/stacks.json (untracked).";
      }

      /* 2 · one file per permanently free story, and no other file at all. */
      const dir = path.join(DATA, "story");
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
      const have = new Set(files.map((f) => f.replace(/\.json$/, "")));
      const extra = [...have].filter((id) => !free.has(id));
      if (extra.length) {
        return "data/story/ publishes stories that are not free: " + extra.join(", ") +
               " — run node tools/split-stacks.js";
      }
      const missing = [...free].filter((id) => !have.has(id));
      if (missing.length) {
        return "free stories with no static file: " + missing.join(", ") +
               " — run node tools/split-stacks.js";
      }

      /* 3 · every other file under data/, structurally. A card is an object
         with a head and a body; only the free story files may hold one. */
      const walk = (d, out) => {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p, out);
          else out.push(p);
        }
        return out;
      };
      const all = walk(DATA, []);
      const allowed = new Set([...free].map((id) => path.join(dir, id + ".json")));
      const bodies = (v, at, hits) => {
        if (Array.isArray(v)) { v.forEach((x, i) => bodies(x, at + "[" + i + "]", hits)); return hits; }
        if (v && typeof v === "object") {
          for (const k of Object.keys(v)) {
            if (k === "body" && typeof v[k] === "string" && v[k].trim().length > 20) {
              hits.push(at + ".body");
            }
            bodies(v[k], at + "." + k, hits);
          }
        }
        return hits;
      };
      for (const p of all) {
        if (allowed.has(p) || !p.endsWith(".json")) continue;
        let doc;
        try { doc = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { continue; }
        const hits = bodies(doc, "", []);
        if (hits.length) {
          return path.relative(ROOT, p) + " carries " + hits.length +
                 " card bodies (first at " + hits[0] + ") — only the free " +
                 "stories may publish text";
        }
      }

      /* 4 · and textually, against the real thing, when the corpus is here.
         The structural pass above knows what a card looks like; this one
         knows what the paid stories actually SAY, so it also catches text
         copied into a file that never mentions a card. The stack's own hook
         is exempt: it is the cover line, it is the pitch, and split-stacks
         publishes it on purpose. */
      const corpus = path.join(ROOT, "content", "stacks.json");
      if (fs.existsSync(corpus)) {
        let src;
        try { src = JSON.parse(fs.readFileSync(corpus, "utf8")).stacks; }
        catch (e) { return "content/stacks.json is unreadable: " + e.message; }
        const texts = all.map((p) => [p, fs.readFileSync(p, "utf8")]);
        for (const s of src) {
          if (s.free === true) continue;
          const hook = String(s.hook || "");
          for (const c of s.cards || []) {
            const b = String(c.body || "").trim();
            if (b.length < 40 || hook.indexOf(b) !== -1) continue;
            for (const [p, t] of texts) {
              if (t.indexOf(b) !== -1) {
                return path.relative(ROOT, p) + " contains the body of card " +
                       c.n + " of story " + s.id + ", which is a paid story";
              }
            }
          }
        }
        /* The corpus itself must never be tracked, or the next push publishes
           it and nothing above would notice: it is not under data/. */
        try {
          const tracked = require("child_process")
            .execSync("git ls-files content", { cwd: ROOT }).toString().trim();
          if (tracked) return "content/ is tracked by git (" + tracked.split("\n")[0] +
                              ") — the corpus would be published on the next deploy";
        } catch (e) { /* no git here; the file checks above still stand */ }
      }

      /* 5 · and the reader's head script must know the same list, or it
         speculatively fetches a file that is not there on every locked open. */
      const rd = read("read.html");
      const m = /window\.FB_FREE_FILE\s*=\s*\{([^}]*)\}/.exec(rd);
      if (rd && !m) return "read.html no longer declares FB_FREE_FILE";
      if (m) {
        const listed = new Set((m[1].match(/"([A-Za-z0-9_-]+)"\s*:/g) || [])
          .map((x) => x.replace(/["':\s]/g, "")));
        const a = [...free].sort().join(","), b = [...listed].sort().join(",");
        if (a !== b) {
          return "read.html's FB_FREE_FILE is [" + b + "] but data/index.json " +
                 "says the free stories are [" + a + "]";
        }
      }

      return true;
    },
  },
  {
    name: "the longer trial cannot be promised without a validated code",
    why: "The campaign is 'comment HISTORY and I'll DM you a week free'. The " +
         "site must never say a week unless the reader is actually getting a " +
         "week. There are exactly two states — no valid code means the " +
         "standard wording, a valid code means the longer wording AND a " +
         "checkout that grants it — and the worst outcome available is the " +
         "third one: week-free copy with a three-day checkout behind it. That " +
         "promises something the till will not honour, which is the class of " +
         "defect STRIPE.md and this file exist to prevent. The way it comes " +
         "back is somebody typing the campaign's promise into markup, or " +
         "adding a second trial sentence that FBA.trialDays() does not feed.",
    pass: () => {
      /* Comments quote the campaign line on purpose — that is how the next
         person knows what this is for — so they come out before the search,
         the same rule tools/check-account-cache.js uses. HTML comments and
         block comments go entirely; only lines that START with // are treated
         as line comments, so a URL is never mistaken for one. */
      const strip = (t) => t
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");

      /* Every way a longer trial can be spelled in reader-facing copy. The
         standard trial is 3 days, so none of these can be true today for a
         reader who has not been validated. */
      const PROMISE = /\b(a |one )?week(s)? free\b|\b7[- ]days? free\b|\bseven[- ]days? free\b|\bfree (for )?(a |one )?week\b/i;

      const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"))
        .concat(fs.readdirSync(path.join(ROOT, "js"))
          .filter((f) => f.endsWith(".js")).map((f) => "js/" + f));

      for (const f of files) {
        const src = strip(read(f));
        const m = PROMISE.exec(src);
        if (m) {
          const at = src.slice(Math.max(0, m.index - 60), m.index + 60)
            .replace(/\s+/g, " ").trim();
          return f + ' contains the literal "' + m[0] + '" outside a comment: ' +
                 '…' + at + '… — the trial sentence must come from ' +
                 'FBA.trialWords()/trialShort(), never from typed copy';
        }
      }

      /* 2 · the static markup on /join must not name a trial AT ALL.

         This used to require the opposite: three <b class="jn-trial">
         strings spelling out the standard length, because that is what a
         script-less reader sees and what the page shows before promoBoot()
         has heard anything back. It guarded the right thing in a shape that
         can only ever be right for one value of the constant — at
         TRIAL_DAYS = 0 it would have demanded the words "zero days free" be
         typed into the page.

         So the markup now carries only the half of each sentence that is
         true with or without a trial, and js/account.js writes every
         sentence that mentions one. A script-less reader is told LESS than
         the offer, never something other than it, in both states. */
      const acct = read("js/account.js");
      const td = /var TRIAL_DAYS = (\d+);/.exec(acct);
      if (!td) return "js/account.js no longer declares TRIAL_DAYS";
      const joinSrc = read("join.html");
      const joinMarkup = joinSrc
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<script[\s\S]*?<\/script>/g, " ");
      const typedTrial =
        /\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)[- ]days? free\b|\bfree trial\b|\buntil the trial ends\b/i
          .exec(joinMarkup);
      if (typedTrial) {
        return 'join.html markup types "' + typedTrial[0] + '" — the trial is ' +
               'described by js/account.js (joinBlurb, planBlurb, ctaLabel, ' +
               'termsFor), never typed into the page, because at TRIAL_DAYS = 0 ' +
               'the whole sentence changes and typed prose cannot follow';
      }
      for (const fn of ["joinBlurb", "planBlurb", "ctaLabel", "termsFor"]) {
        if (!new RegExp("A\\." + fn + "\\(").test(joinSrc)) {
          return "join.html no longer paints its offer copy from FBA." + fn +
                 "() — that is the only place the no-trial wording exists";
        }
      }

      /* 3 · one source for the sentence. trialWords/trialShort must read
         trialDays(), and trialDays() must be the thing that consults the
         promo. Point either of them back at the TRIAL_DAYS constant and a
         validated reader silently gets the standard wording; point the copy
         somewhere else entirely and the promo can be shown without a link. */
      const a = acct.replace(/\/\*[\s\S]*?\*\//g, " ");
      if (!/function trialDays\(\)\s*\{\s*return PROMO_ON \? PROMO\.trialDays : TRIAL_DAYS;/.test(a)) {
        return "js/account.js trialDays() no longer resolves the promo — it is " +
               "the single answer every trial sentence is drawn from";
      }
      if (!/function trialShort\(\)\s*\{\s*return trialDays\(\) \?/.test(a) ||
          !/function trialWords\(\)\s*\{\s*return trialDays\(\) \? words\(trialDays\(\)\)/.test(a)) {
        return "js/account.js trialShort()/trialWords() no longer read trialDays() " +
               "through the zero test — both must answer \"\" when there is no " +
               "trial, or the site says \"0 days free\"";
      }

      /* 4 · the ONLY switch, and it is gated on a real Payment Link. */
      const setsOn = (a.match(/PROMO_ON = true/g) || []).length;
      if (setsOn !== 1) {
        return "js/account.js turns PROMO_ON on in " + setsOn + " places; there " +
               "must be exactly one, inside applyPromo()";
      }
      const applyBody = /function applyPromo\(days\)[\s\S]*?\n  \}/.exec(a);
      if (!applyBody) return "js/account.js no longer defines applyPromo(days)";
      if (!/n !== PROMO\.trialDays/.test(applyBody[0]) ||
          !/if \(!promoReady\(\)\)/.test(applyBody[0])) {
        return "applyPromo() no longer refuses when the function's trial length " +
               "disagrees, or when there is no promotional Payment Link — those " +
               "two refusals are what stop the week-free copy appearing over a " +
               "three-day checkout";
      }

      /* 5 · the browser must never learn the trial length from the URL. The
         code in a link is a claim; only functions/promo.js's answer is a
         fact. So join.html gets exactly one applyPromo() call, and its
         argument is the function's reply. */
      const jsrc = read("join.html").replace(/\/\*[\s\S]*?\*\//g, " ");
      const calls = jsrc.match(/applyPromo\(([^)]*)\)/g) || [];
      const real = calls.filter((c) => !/^applyPromo\(\)$/.test(c));
      if (real.length !== 1 || !/applyPromo\(r\.trialDays\)/.test(real[0])) {
        return "join.html calls applyPromo as [" + real.join(", ") + "]; it must " +
               "be called exactly once, with the trial length functions/promo.js " +
               "returned — never with anything read out of the query string";
      }
      if (!/promoCall\("validate"/.test(jsrc) || !/promoCall\("redeem"/.test(jsrc)) {
        return "join.html no longer validates on load and redeems at checkout";
      }

      return true;
    },
  },
  {
    name: "the promo trial length agrees everywhere",
    why: "Three systems that cannot import from each other hold the same " +
         "number: js/account.js decides the WORDING and which Payment Link " +
         "the reader is sent to, functions/promo.js decides whether a code is " +
         "honoured at all, and tools/mint-promo-codes.js writes it onto every " +
         "code it mints. Let them drift and the site says one length while the " +
         "checkout grants another — or, if the function's clamp catches it, a " +
         "whole campaign of codes validates as `unknown` and every reader who " +
         "was DM'd a week gets the standard trial with nothing said about it.",
    pass: () => {
      const num = (file, re, what) => {
        const m = re.exec(read(file));
        return m ? { n: Number(m[1]), where: file + " " + what }
                 : { n: null, where: file + " " + what };
      };
      const seen = [
        num("js/account.js", /var PROMO = \{[\s\S]{0,2000}?trialDays:\s*(\d+)/, "PROMO.trialDays"),
        num("functions/promo.js", /const PROMO_TRIAL_DAYS = (\d+);/, "PROMO_TRIAL_DAYS"),
        num("tools/mint-promo-codes.js", /const TRIAL_DAYS = (\d+);/, "TRIAL_DAYS"),
      ];
      const missing = seen.filter((x) => !(x.n > 0));
      if (missing.length) return "cannot find " + missing.map((x) => x.where).join(", ");
      const first = seen[0].n;
      const off = seen.filter((x) => x.n !== first);
      if (off.length) {
        return seen.map((x) => x.where + " = " + x.n).join(", ") + " — they must agree";
      }

      /* And the promo must be LONGER than the standard trial. A promo equal to
         or shorter than the standard one is a campaign that promises a reader
         something they already had, and the copy would go backwards. */
      const std = /var TRIAL_DAYS = (\d+);/.exec(read("js/account.js"));
      if (std && Number(std[1]) >= first) {
        return "the promo trial is " + first + " days and the standard trial is " +
               std[1] + " — a promo must be longer than what everybody gets";
      }

      /* The alphabet the minter uses and the alphabet the function accepts
         must be the same string, or every minted code validates as unknown. */
      const mintA = /const ALPHABET = "([^"]+)";/.exec(read("tools/mint-promo-codes.js"));
      const fnA = /const ALPHABET = "([^"]+)";/.exec(read("functions/promo.js"));
      if (!mintA || !fnA) return "the code alphabet is no longer declared in both files";
      if (mintA[1] !== fnA[1]) {
        return "the minter's alphabet and the function's alphabet differ — every " +
               "code minted would validate as `unknown`";
      }
      const mintL = /const CODE_LEN = (\d+);/.exec(read("tools/mint-promo-codes.js"));
      const fnL = /const CODE_LEN = (\d+);/.exec(read("functions/promo.js"));
      if (!mintL || !fnL || mintL[1] !== fnL[1]) {
        return "the minter and the function disagree about code length";
      }
      /* The alphabet is the campaign's whole defence against a for-loop, and
         it is also what makes a code survive being read off a DM. Both O/0
         and I/1/l must be absent, and so must the vowels that let a random
         string spell a word. */
      if (/[AEIOUL01]/.test(fnA[1])) {
        return "the code alphabet contains one of A E I O U L 0 1 — the vowels " +
               "let a random code spell a word, and O/0 and I/1/l are the pairs " +
               "that break a code retyped from a DM";
      }
      if (fnA[1].length < 24 || Number(fnL[1]) < 10) {
        return "the code space has shrunk below 24^10 — a sequential or short " +
               "code means one person with a for-loop drains the campaign";
      }
      return true;
    },
  },
  {
    name: "no trial sentence can render while trialDays() is 0",
    why: "The offer is being restructured into four Payment Links: monthly " +
         "and annual with NO trial, which is what everybody sees, and monthly " +
         "and annual with a 7-day trial behind a promo code. The day that " +
         "lands, TRIAL_DAYS becomes 0 — and every sentence built by sticking " +
         "a number in front of \" days free\" then renders \"0 days free\", " +
         "every sentence that ends \"cancel before the trial ends and you are " +
         "not charged\" describes a trial nobody is being given, and the site " +
         "promises something the till will not honour. That is the same defect " +
         "class as a price the checkout does not charge, arrived at from the " +
         "copy side. So this does not grep: it EVALUATES js/account.js with " +
         "TRIAL_DAYS forced to 0 and reads the sentences it produces. It also " +
         "checks 3 and 7, because the fix must be invisible until the constant " +
         "moves — a no-trial site is only correct if the trial site is intact.",
    pass: () => {
      const vm = require("vm");
      const src = read("js/account.js");
      if (!/var TRIAL_DAYS = \d+;/.test(src)) {
        return "js/account.js no longer declares TRIAL_DAYS as a plain number, " +
               "so this check cannot set it to 0";
      }
      /* account.js is an IIFE assigning to a var, with every browser API it
         touches behind a try/catch, so it evaluates in a bare context. That
         is what makes a behavioural check possible here at all. */
      const load = (days) => {
        const ctx = { console: { log() {}, warn() {}, error() {} } };
        vm.createContext(ctx);
        vm.runInContext(
          src.replace(/var TRIAL_DAYS = \d+;/, "var TRIAL_DAYS = " + days + ";") +
          "\n;FBA;", ctx, { timeout: 5000 });
        return ctx.FBA;
      };

      let A0;
      try { A0 = load(0); }
      catch (e) { return "js/account.js does not evaluate with TRIAL_DAYS = 0: " + e.message; }
      const plan = A0.planByKey("annual") || A0.plans()[0];
      if (!plan) return "no offered plan to price the sentences with";

      const said = [
        ["trialShort()", A0.trialShort()],
        ["trialWords()", A0.trialWords()],
        ["ctaLabel()", A0.ctaLabel()],
        ["joinBlurb()", A0.joinBlurb()],
        ["planBlurb()", A0.planBlurb()],
        ["termsFor(plan)", A0.termsFor(plan)],
      ];

      /* Every way a trial can be spelled. "free" on its own is NOT here:
         "Two stories are free" is true whatever the plans do, and banning
         the word would push somebody into rewording a sentence that was
         already right. What is banned is a free PERIOD, and the promise
         that hangs off one. */
      const TRIALISH =
        /\btrial\b|\d+ *days? free|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)[- ]days? free|\bfree for\b|\bnothing is charged\b|\bnot charged\b|cancel before/i;
      /* On the plan screen and its terms line there is no free anything, so
         the word itself must not appear there either. */
      const PLAN_SCREEN = { "ctaLabel()": 1, "planBlurb()": 1, "termsFor(plan)": 1 };

      for (const [what, line] of said) {
        const hit = TRIALISH.exec(line);
        if (hit) {
          return "at TRIAL_DAYS = 0, FBA." + what + ' says "' + line + '" — it ' +
                 'names a trial ("' + hit[0] + '") that no Payment Link grants';
        }
        if (PLAN_SCREEN[what] && /\bfree\b/i.test(line)) {
          return "at TRIAL_DAYS = 0, FBA." + what + ' says "' + line +
                 '" — nothing on the plan screen is free';
        }
        /* A phrase that answered "" and was concatenated anyway. */
        if (/ {2,}/.test(line) || /(^|[^.])\bStart\s*$/.test(line) ||
            /,\s*$|\bthen\s*$|\bwith\s*$/.test(line.trim())) {
          return "at TRIAL_DAYS = 0, FBA." + what + ' says "' + line +
                 '" — a caller concatenated the empty trial phrase instead of ' +
                 'branching on it';
        }
      }

      /* The reassurance has to MOVE, not vanish: with nothing to cancel
         before, the guarantee is the only thing left saying what happens if
         they do not want it. One wording, from one constant. */
      const G = String(A0.GUARANTEE || "");
      if (!G || !/refund/i.test(G)) {
        return "js/account.js no longer states the money-back guarantee";
      }
      for (const what of ["planBlurb()", "termsFor(plan)"]) {
        const line = said.find((x) => x[0] === what)[1];
        if (line.indexOf(G) === -1) {
          return "at TRIAL_DAYS = 0, FBA." + what + " no longer carries the " +
                 "guarantee — the trial went and nothing replaced it";
        }
      }
      if (!/money-back guarantee/i.test(read("terms.html"))) {
        return "terms.html no longer says a plan may be sold with a money-back " +
               "guarantee — the plan screen would promise a refund the Terms deny";
      }

      /* And the other direction: with a trial, the trial is still named,
         in exactly the words it was named in before any of this. */
      const A3 = load(3);
      const A7 = load(7);
      const want = [
        [A3.trialShort(), "3 days free"],
        [A3.trialWords(), "three days free"],
        [A3.ctaLabel(), "Start 3 days free"],
        [A7.trialShort(), "7 days free"],
        [A7.ctaLabel(), "Start 7 days free"],
      ];
      for (const [got, expect] of want) {
        if (got !== expect) {
          return 'with a trial the wording moved: got "' + got + '", expected "' +
                 expect + '"';
        }
      }
      const t3 = A3.termsFor(A3.planByKey("annual"));
      if (t3.indexOf("Three days free, then ") !== 0 ||
          t3.indexOf("Cancel before the trial ends and you are not charged.") === -1) {
        return "the WITH-a-trial terms sentence has changed: " + t3;
      }
      if (!/blurb|jn-blurb/.test(read("join.html"))) return "join.html lost #jn-blurb";

      /* js/recommend.js paints the same offer on the paywall and the end
         card and has its own trialDays()/trialShort(). It must read the
         guarantee from account.js too, and its end-card offer line must not
         disappear when the trial does — a sheet that asks for a subscription
         without naming the price is worse than one with no trial in it. */
      const rec = read("js/recommend.js");
      if (!/function guarantee\(\)[\s\S]{0,200}A\.guarantee\(\)/.test(rec)) {
        return "js/recommend.js does not read the guarantee from FBA — two " +
               "wordings of one promise is how the refund window ends up " +
               "being a month on one screen and thirty days on another";
      }
      if (!/if \(!p \|\| !p\.billedLine\) return null;/.test(rec)) {
        return "js/recommend.js offerLine() still bails when there is no trial, " +
               "so the end card at TRIAL_DAYS = 0 offers a subscription and " +
               "never says what it costs";
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
