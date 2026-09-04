/* The instrumentation, asserted so it cannot quietly go away.

   Analytics is the one part of a site that fails silently by design. A page
   that stops rendering is reported within the hour; a page that stops
   REPORTING looks exactly like a page nobody visited, and the first anyone
   knows is a founder asking why /start has no traffic. This site has already
   run that experiment by accident: start.html shipped without ever loading
   js/analytics.js, so every start_step the onboarding fired for its whole life
   went nowhere at all, and the number that came back was zero rather than
   an error.

   So these are static checks on the source, in the manner of
   check-regressions.js, and they cover the two things the coverage rests on:

     * EVERY page loads the file that sends the page view. One missing script
       tag is one page that vanishes from every report.
     * The onboarding still records an ANSWER and a DWELL for each question.

   plus the GA4 rules that are silent when broken: a name GA4 refuses is an
   event GA4 drops, not an event GA4 complains about.

   Run:  node tools/check-analytics.js
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = f => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { return ""; } };

const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith(".html")).sort();
const SCRIPTS = fs.readdirSync(path.join(ROOT, "js")).filter(f => f.endsWith(".js")).map(f => "js/" + f);
const ALL = PAGES.concat(SCRIPTS);

/* GA4 refuses these outright, or silently replaces them with its own. Copied
   from the same list js/analytics.js maps against. */
const RESERVED = new Set(("ad_activeview ad_click ad_exposure ad_query ad_reward adunit_exposure " +
  "app_background app_clear_data app_exception app_remove app_store_refund " +
  "app_store_subscription_cancel app_store_subscription_convert app_store_subscription_renew " +
  "app_update app_upgrade dynamic_link_app_open dynamic_link_app_update dynamic_link_first_open " +
  "error first_open first_visit in_app_purchase notification_dismiss notification_foreground " +
  "notification_open notification_receive os_update session_start screen_view user_engagement " +
  "firebase_campaign page_view").split(" "));

/* Every event name written as a literal anywhere on the site, including the
   two ternaries (stack_complete/stack_dropoff, save_add/save_remove). */
function eventNames() {
  const out = new Map();          /* name -> the file it was found in */
  const call = /(?:FB\.track|G\.track|window\.track|\btrack|\bcapture)\s*\(\s*([^)]{0,160})/g;
  const lit = /"([A-Za-z][A-Za-z0-9_]{0,63})"/g;
  for (const f of ALL) {
    const s = read(f);
    let m;
    while ((m = call.exec(s))) {
      /* Only the first argument: everything up to the comma that ends it. A
         ternary has no top-level comma, so both of its literals are read. */
      const arg = m[1].split(/,(?![^(]*\))/)[0];
      if (!/^[\s"']/.test(arg) && !/^\w+\s*(?:>=|===|==|<|>|\?)/.test(arg)) continue;
      let n;
      while ((n = lit.exec(arg))) if (!out.has(n[1])) out.set(n[1], f);
    }
  }
  return out;
}

const CHECKS = [
  {
    name: "every page loads the file that sends the page view",
    why: "js/analytics.js is the only script on every page and it is what sends " +
         "page_open. A page without the tag reports nothing and looks unvisited. " +
         "start.html shipped in exactly that state.",
    pass: () => {
      /* The TAG, not a mention of it. start.html names the file in a comment
         explaining why it is loaded, and a looser test passed on the comment
         alone while the tag was gone. */
      const tag = /<script\b[^>]*\bsrc\s*=\s*["']\/js\/analytics\.js["']/;
      const missing = PAGES.filter(f => !tag.test(read(f)));
      return missing.length ? "missing on " + missing.join(", ") : true;
    },
  },
  {
    name: "one page-view event, with a page parameter, not one name per page",
    why: "A name per page is an unbounded set of event names, which GA4 caps " +
         "and reports on badly. One literal name, and the page in a parameter.",
    pass: () => {
      const s = read("js/analytics.js");
      return /capture\("page_open",\s*\{\s*page:\s*PAGE\s*\}\)/.test(s) &&
             /function pageName\(\)/.test(s);
    },
  },
  {
    name: "one delegated listener carries every control, not 102 handlers",
    why: "A listener per button is a maintenance trap and gets half-wired. One " +
         "delegated listener in the capture phase sees every tap, including " +
         "controls other scripts build after load.",
    pass: () => {
      const s = read("js/analytics.js");
      return /document\.addEventListener\("click",[\s\S]{0,400}?\}, true\)/.test(s) &&
             /capture\("ui_click",\s*\{\s*page:\s*PAGE,\s*control:/.test(s);
    },
  },
  {
    name: "a control that has its own event is not counted twice",
    why: "ui_click on top of save_add counts one tap as two and breaks every " +
         "funnel built on the specific name. The skip is the data-fbt seam plus " +
         "a named list of the controls other files build.",
    pass: () => {
      const s = read("js/analytics.js");
      return /function skipControl\(/.test(s) && /data-fbt/.test(s) &&
             /fbs-save/.test(s) && /ec-go/.test(s) && /data-unsave/.test(s) &&
             /data-fbt/.test(read("js/saves.js")) &&
             /data-fbt/.test(read("js/recommend.js")) &&
             /data-fbt/.test(read("js/library.js"));
    },
  },
  {
    name: "time on a story is measured, not just time on a card",
    why: "card_view answers 'which card lost them'. story_time answers 'how " +
         "long did the story hold anyone', and it stops the clock while the tab " +
         "is hidden so a phone in a pocket is not reported as reading.",
    pass: () => {
      const s = read("js/analytics.js");
      return /capture\("story_time",\s*\{\s*stack:[^}]*dwell_ms:[^}]*cards:/.test(s) &&
             /if \(name === "stack_open"\) storyOpen/.test(s) &&
             /visibilitychange/.test(s) && /pagehide/.test(s);
    },
  },
  {
    name: "the retired onboarding is retired in one piece",
    why: "THIS CHECK REPLACED FIVE. /join used to open with five screens of " +
         "questions driven by js/start.js, and five guards here asserted that " +
         "each of them still recorded an answer, a dwell and an abandon. The " +
         "conversion flow was redesigned around asking for an ACCOUNT inside " +
         "the story instead of asking questions on the way to a price, so the " +
         "screens, the engine and its instrumentation are gone together.\n" +
         "      A check that asserts a flow nobody ships fails for the wrong " +
         "reason and then gets ignored, which is how a real failure hides " +
         "behind a stale one — tools/check-shelf.js is the cautionary tale in " +
         "this repo. So the five are replaced by one, and what it guards is " +
         "that the retirement stays WHOLE: nobody puts the screens back " +
         "without the engine, or the engine back without the screens and " +
         "their instrumentation. Bringing the flow back means bringing back " +
         "the five guards with it.",
    pass: () => {
      const engine = read("js/start.js");
      const page = read("join.html");
      const hasScreens = /id="ob-stage"/.test(page) || /js\/start\.js"><\/script>/.test(page);
      if (!engine && !hasScreens) return true;
      if (engine && hasScreens) {
        /* Somebody has brought it back. The five guards that went with it are
           what has to come back too, and this check cannot stand in for them. */
        return "js/start.js and /join's question screens are both back; " +
               "restore the five start_step / start_answer / start_abandon " +
               "guards this check replaced";
      }
      return engine
        ? "js/start.js is still here but /join no longer loads it — dead code"
        : "/join still carries the question screens but js/start.js is gone — " +
          "five screens with no script to advance them is a dead end";
    },
  },
  {
    name: "no event name is built at runtime",
    why: "click_<id> or view_<page> is an unbounded set of names. GA4 caps " +
         "distinct names and reports badly long before the cap. One literal " +
         "name, detail in parameters.",
    pass: () => {
      const bad = [];
      for (const f of ALL) {
        const s = read(f);
        /* A first argument that concatenates, or is a bare identifier that is
           not a parameter of a wrapper function. */
        if (/(?:FB\.track|\btrack|\bcapture)\(\s*"[^"]*"\s*\+/.test(s)) bad.push(f + " (concatenated)");
        if (/(?:FB\.track|\btrack|\bcapture)\(\s*[A-Za-z_$][\w$]*\s*\+/.test(s)) bad.push(f + " (built from a variable)");
      }
      return bad.length ? bad.join(", ") : true;
    },
  },
  {
    name: "every event name is legal GA4 and none is reserved",
    why: "GA4 drops a reserved name silently and rewrites an illegal one. " +
         "40 characters, [a-z0-9_], must start with a letter.",
    pass: () => {
      const bad = [];
      for (const [n, f] of eventNames()) {
        if (n.length > 40) bad.push(n + " in " + f + " (over 40 chars)");
        else if (!/^[a-z][a-z0-9_]*$/.test(n)) bad.push(n + " in " + f + " (illegal characters)");
        else if (RESERVED.has(n)) bad.push(n + " in " + f + " (GA4 reserved)");
        else if (/^(ga_|google_|firebase_)/.test(n)) bad.push(n + " in " + f + " (reserved prefix)");
      }
      return bad.length ? bad.join("; ") : true;
    },
  },
  {
    name: "every parameter value is clipped to GA4's 100 characters",
    why: "GA4 truncates a long string value and PostHog does not, so the same " +
         "event ends up two different strings in the two sinks. Clip at the " +
         "call site and they agree.",
    /* js/start.js had its own copy, because it sent its own events without
       going through analytics.js. It is retired; analytics.js is the only
       clipper left, which is one fewer place for the two to disagree. */
    pass: () => /function clip\(/.test(read("js/analytics.js")) &&
                /var CLIP = 100;/.test(read("js/analytics.js")),
  },
  {
    name: "nothing a reader typed is ever sent",
    why: "An onboarding answer is a tap on a fixed list and is fine. An email " +
         "address, a name, a password or the contents of any field is not, in " +
         "any event, in either sink, ever.",
    pass: () => {
      const bad = [];
      const call = /(?:FB\.track|\btrack|\bcapture)\s*\(([^;]{0,300})/g;
      for (const f of ALL) {
        const s = read(f);
        let m;
        while ((m = call.exec(s))) {
          const arg = m[1];
          if (/\.value\b/.test(arg)) bad.push(f + ": reads .value");
          if (/password/i.test(arg)) bad.push(f + ": mentions password");
          if (/\bemail\s*:/.test(arg) || /\bname\s*:\s*[A-Za-z_$]/.test(arg)) bad.push(f + ": sends an email or a name");
        }
      }
      return bad.length ? [...new Set(bad)].join(", ") : true;
    },
  },
];

let bad = 0;
for (const c of CHECKS) {
  let r;
  try { r = c.pass(); } catch (e) { r = "threw: " + e.message; }
  if (r === true) console.log("ok    " + c.name);
  else { bad++; console.log("FAIL  " + c.name + "\n      " + c.why + "\n      -> " + r + "\n"); }
}
const names = eventNames();
console.log("\n" + names.size + " event names in the source, " +
            CHECKS.length + " instrumentation guards, " + bad + " broken");
process.exit(bad ? 1 : 0);
