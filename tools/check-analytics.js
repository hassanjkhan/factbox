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
      /* ui_click's properties are built into an object now, because a toggle
         adds was_on and a control that is not a toggle must not. The two
         things this guards are unchanged: ONE listener, and it is on the
         document in the CAPTURE phase so a handler calling stopPropagation
         cannot hide a tap from it. */
      return /document\.addEventListener\("click",[\s\S]{0,900}?\}, true\)/.test(s) &&
             /var props = \{ page: PAGE, control: clip\(controlName\(n\), CLIP\) \};/.test(s) &&
             /capture\("ui_click", props\);/.test(s);
    },
  },
  {
    name: "a control that has its own event is not counted twice",
    why: "ui_click on top of save_add counts one tap as two and breaks every " +
         "funnel built on the specific name. The skip is the data-fbt seam plus " +
         "a named list of the controls other files build.",
    pass: () => {
      const s = read("js/analytics.js");
      if (!(/function skipControl\(/.test(s) && /data-fbt/.test(s) &&
            /fbs-save/.test(s) && /ec-go/.test(s) && /data-unsave/.test(s) &&
            /data-fbt/.test(read("js/saves.js")) &&
            /data-fbt/.test(read("js/recommend.js")) &&
            /data-fbt/.test(read("js/library.js")))) return "the skip seam is incomplete";

      /* Two more that were found double-counting a real tap, both verified in
         Chrome before they were added. The named event fires from the same
         tap with nothing in front of it, so ui_click was a second count of
         one press.

         The test for this list is UNCONDITIONAL: a named event inside a
         .then() is a success and ui_click is an attempt, and those are two
         different facts worth having. That is why #au-go, #au-google, #au-out
         and #st-out are deliberately absent, and why this check asserts they
         stay absent — a later pass "tidying up the duplicates" would
         otherwise silently delete every failed sign-in from the record. */
      if (!/"st-billing": 1/.test(s))
        return "#st-billing is not skipped; settings.html fires billing_portal on the same tap, unconditionally";
      if (!/"jn-yn"/.test(s))
        return ".jn-yn is not skipped; join.html already sends join_plan_answer{n, yes}, which says which way they answered";
      const kept = ["au-go", "au-google", "au-out", "st-out"];
      const wrong = kept.filter(id => new RegExp('"' + id + '"\\s*:\\s*1').test(s));
      if (wrong.length)
        return wrong.join(", ") + " has been skipped, but its named event fires only on success — " +
               "skipping the control throws away every failed attempt, which is the half that says why it is not working";
      return true;
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
    name: "a save is counted at the save, not at the page load",
    why: "js/saves.js's button() took a callback parameter called `onChange`, " +
         "which shadowed the module's own subscribe function of the same name " +
         "eleven lines from the top of the file. The repaint subscription at " +
         "the bottom of button() therefore called the CALLER back, once, at " +
         "build time, with a function as its first argument — truthy — and all " +
         "four readers turn that argument straight into " +
         "FB.track(isSaved ? \"save_add\" : \"save_remove\"). Every save_add on " +
         "the dashboard was a story being opened. The shadow is the whole bug, " +
         "so the shadow is what is guarded: the parameter may not be called " +
         "onChange again, and the subscription must still be there.",
    pass: () => {
      const s = read("js/saves.js");
      if (!/function button\(\s*id\s*,\s*onToggle\s*,/.test(s)) {
        return "js/saves.js button()'s callback parameter is no longer `onToggle` — " +
               "if it has been renamed back to `onChange` it shadows the module's " +
               "subscribe function and save_add fires on every page load";
      }
      if (/function onChange\(fn\)/.test(s) === false) return "js/saves.js has no module-level onChange(fn) to subscribe to";
      /* The repaint must hang off the store, and the caller must be called
         only from inside the click handler. */
      if (!/b\.unbind = onChange\(function \(\) \{ try \{ paint\(\); \}/.test(s))
        return "the save button no longer subscribes its repaint to the store";
      /* Count CALLS, not mentions: the docstring above button() names the
         parameter with its arguments and would otherwise count as one. */
      const calls = (s.replace(/\/\*[\s\S]*?\*\//g, "").match(/\bonToggle\s*\(/g) || []).length;
      if (calls !== 1) return "onToggle is called " + calls + " times outside comments; it must be called once, from the click handler";
      if (!/if \(typeof onToggle === "function"\) onToggle\(on, k\);/.test(s))
        return "the only call to onToggle is not the one inside the click handler";
      return true;
    },
  },
  {
    name: "a client error is reported, in the shape the query API reads",
    why: "Nothing listened on window.onerror or unhandledrejection on any page, " +
         "ever. A story that threw on card three looked identical to a reader " +
         "who got bored: both are a stack_dropoff and nothing else. One event " +
         "name, five parameters, both sources of failure.",
    pass: () => {
      const s = read("js/analytics.js");
      if (!/capture\("client_error", \{\s*message: msg, source: src, line: ln, page: PAGE, release: RELEASE\s*\}\)/.test(s))
        return "client_error is not sent with exactly message, source, line, page, release";
      if (!/addEventListener\("error",/.test(s)) return "nothing listens for an uncaught error";
      if (!/addEventListener\("unhandledrejection",/.test(s)) return "nothing listens for an unhandled rejection";
      /* window.onerror = ... would silently replace whatever a page had, and
         js/scenes.js already listens for `error` its own way. */
      if (/window\.onerror\s*=/.test(s)) return "js/analytics.js assigns window.onerror instead of adding a listener";
      return true;
    },
  },
  {
    name: "a render loop cannot send more than a known number of errors",
    why: "Both readers repaint on a MutationObserver and on scroll, so a throw " +
         "inside one is a throw per frame. Unlimited, one phone on one story " +
         "posts tens of thousands of events, drowns the real traffic in the " +
         "same charts the owner is reading, and is billed for twice. The bound " +
         "has to be arithmetic and per page load — not a rate anyone has to " +
         "believe.",
    pass: () => {
      const s = read("js/analytics.js");
      const max = s.match(/var ERR_MAX\s*=\s*(\d+);/);
      if (!max) return "there is no ERR_MAX ceiling";
      if (Number(max[1]) < 1 || Number(max[1]) > 25) return "ERR_MAX is " + max[1] + "; a page-load ceiling above 25 is not a ceiling";
      if (!/if \(errSent >= ERR_MAX\) return;/.test(s)) return "ERR_MAX is declared but never enforced";
      if (!/if \(errSeen\[sig\] === 1\) return;/.test(s)) return "the same error is not deduplicated, so a loop pays per frame";
      if (!/errSent\+\+;/.test(s)) return "nothing increments the count the ceiling is checked against";
      if (!/if \(sending\) return;/.test(s)) return "reporting is re-entrant: an error inside the reporter can report itself";
      return true;
    },
  },
  {
    name: "no error is reported from a page that is leaving, and bfcache still works",
    why: "A navigation cancels every request in flight, and the rejections that " +
         "produces are what leaving a page looks like from inside it, not a " +
         "fault. pagehide is the bfcache-safe signal for it. pageshow has to " +
         "clear the flag or one Back tap leaves a live page that never reports " +
         "again — and an unload or beforeunload listener ANYWHERE on the site " +
         "disqualifies every page from bfcache, which js/gate.js's " +
         "back-after-paying correction depends on.",
    pass: () => {
      const s = read("js/analytics.js");
      if (!/addEventListener\("pagehide", function \(\) \{ leftPage = true; \}\)/.test(s))
        return "pagehide does not stop error reporting";
      if (!/addEventListener\("pageshow", function \(\) \{ leftPage = false; \}\)/.test(s))
        return "pageshow does not restore error reporting after a bfcache tap-back";
      if (!/if \(leftPage\) return;/.test(s)) return "the leaving flag is set but never read";
      const bad = [];
      for (const f of ALL) {
        const t = read(f);
        if (/addEventListener\(\s*["'](?:beforeunload|unload)["']/.test(t)) bad.push(f);
        if (/\bon(?:beforeunload|unload)\s*=/.test(t)) bad.push(f);
      }
      return bad.length ? "a bfcache-killing unload listener is back in " + [...new Set(bad)].join(", ") : true;
    },
  },
  {
    name: "an error report cannot carry a token, a session id or an email",
    why: "?restore=<token> is a working key to a paid season and Stripe's " +
         "success redirect carries a session_id. A rejected fetch quotes the " +
         "URL it failed on, and a thrown auth error is entirely capable of " +
         "quoting the email that was just typed. There is no stack parameter " +
         "for the same reason: a stack is many lines of many URLs.",
    pass: () => {
      const s = read("js/analytics.js");
      if (!/function scrub\(v\)/.test(s)) return "there is no scrub()";
      if (!/msg = clip\(scrub\(message\), CLIP\);/.test(s)) return "the message is not scrubbed and clipped before it is sent";
      if (!/function fileOf\(v\)/.test(s)) return "there is no fileOf() to strip a source URL down to a path";
      if (!/var src = fileOf\(source\);/.test(s)) return "the source is sent as given rather than reduced to a path";
      /* The four rules scrub() has to keep: query strings, credentials in a
         URL, email addresses, and any long unbroken run of token characters. */
      if (!/\[\?#\]/.test(s)) return "scrub() no longer strips a query string or a fragment";
      if (!/<email>/.test(s)) return "scrub() no longer redacts an email address";
      if (!/\{24,\}/.test(s)) return "scrub() no longer redacts a long token-shaped run";
      if (/\bstack:\s*/.test(s.slice(s.indexOf('capture("client_error"'))))
        return "client_error has grown a stack parameter";
      return true;
    },
  },
  {
    name: "a toggle says which way it was pointing when it was pressed",
    why: "'Are people using the audio button and then muting the music or " +
         "playing it?' A mute and an unmute were the same row in the same " +
         "report. aria-pressed is already on the sound button and the save " +
         "bookmark for the screen reader, and the click listener is registered " +
         "in the CAPTURE phase, so reading it there is the state at the moment " +
         "of the press — observed, not inferred from a handler this file does " +
         "not own.",
    pass: () => {
      const s = read("js/analytics.js");
      if (!/function toggleState\(n\)/.test(s)) return "there is no toggleState()";
      if (!/getAttribute\("aria-pressed"\)/.test(s)) return "toggleState no longer reads aria-pressed";
      if (!/var was = toggleState\(n\);\s*if \(was !== null\) props\.was_on = was;/.test(s))
        return "ui_click does not carry was_on for a toggle";
      /* null, not false, for a control that is not a toggle — otherwise every
         button on the site lands in the 'was off' bucket. */
      if (!/return null;\s*\/\* not a toggle \*\//.test(s))
        return "toggleState returns something other than null for a control that is not a toggle";
      if (!/\}, true\);/.test(s)) return "the click listener has left the capture phase, so was_on would be the state AFTER the handler ran";
      return true;
    },
  },
  {
    name: "the sound button says what the press will do, in the right direction",
    why: "The one control the owner asked about by name. It carries no id and " +
         "no name, so js/analytics.js had to guess a name by walking up to six " +
         "ancestors, found #fb-rail — the control column it sits in — and filed " +
         "every mute and every unmute as `fb_rail`: one undifferentiated number " +
         "named after a piece of layout.\n" +
         "      THE DIRECTION IS THE WHOLE THING. The delegated listener reads " +
         "data-fbt in the CAPTURE phase, before the button's own handler has " +
         "flipped anything, so the attribute has to name the state the press " +
         "WILL PRODUCE — the inverse of the state the button is in. An " +
         "attribute naming the current state is read one press out of date and " +
         "files every play as a mute. It is the one line in that file where the " +
         "obvious version is backwards, so it is asserted rather than trusted.",
    pass: () => {
      const a = read("js/audio-reader.js");
      if (!a) return "js/audio-reader.js is missing";
      if (!/btn\.setAttribute\("aria-pressed", String\(live\)\);/.test(a))
        return "paint() no longer derives aria-pressed from `live`, which is what the name below is the inverse of";
      /* on/armed -> the press turns it OFF; otherwise the press turns it ON. */
      if (!/btn\.setAttribute\("data-fbt", live \? "sound_off" : "sound_on"\);/.test(a))
        return "the sound button's data-fbt is not `live ? \"sound_off\" : \"sound_on\"` — if the two values have been swapped, " +
               "every mute is now reported as a play and every play as a mute";
      /* A retired button is on screen and tappable for another 2.6 seconds and
         its handler returns immediately, so a tap on it must not be counted. */
      const ret = a.slice(a.indexOf("function retire("), a.indexOf("function drop("));
      if (!/setAttribute\("data-fbt", "-"\)/.test(ret))
        return "a retired sound button does not opt out of ui_click, so a tap that does nothing is reported as a play or a mute";
      /* The two values are what the query API's audio_usage groups on. */
      if (!/data-fbt/.test(read("js/analytics.js")))
        return "js/analytics.js no longer reads data-fbt at all";
      return true;
    },
  },
  {
    name: "there is a release to pin an error spike to",
    why: "This site has no build step: the files are served raw off GitHub " +
         "Pages at the same URLs forever, and nothing a browser can read " +
         "changes when a commit lands. So the release is written down or it " +
         "does not exist. This asserts the SHAPE — it cannot assert that " +
         "somebody remembered to bump it, and pretending otherwise would be " +
         "the fabricated number this repo keeps refusing.",
    pass: () => {
      const s = read("js/analytics.js");
      const m = s.match(/var RELEASE = "([^"]*)";/);
      if (!m) return "js/analytics.js has no RELEASE constant";
      if (!/^\d{4}-\d{2}-\d{2}[a-z]?$/.test(m[1]))
        return "RELEASE is \"" + m[1] + "\"; it must be yyyy-mm-dd with an optional letter, so two deploys on one day are two releases";
      if (!/release: RELEASE/.test(s)) return "RELEASE is declared but not sent on client_error";
      return true;
    },
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
