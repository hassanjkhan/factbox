/* ==========================================================================
   Factbox — the analytics query door.

   The owner wanted a dashboard on factbox.app showing dwell per card, drop-off,
   the subscribe funnel, button presses and crashes, and assumed the data had to
   be built. It did not. `js/analytics.js` has been sending every one of those
   facts to PostHog for weeks — `card_view` already carries `dwell_s`, `ui_click`
   already names every button by its `data-fbt`, and `stack_open` /
   `stack_complete` / `stack_dropoff` already bracket every reading.

   So this file is not a pipeline. Writing those events into Firestore a second
   time would cost a document write on every card a reader looks at, duplicate a
   store that already does this better, and leave two numbers for every question
   with no way to say which was right. This is a DOOR: prove the caller is an
   admin, pick one of seventeen queries THIS FILE wrote, run it against PostHog
   with a key the browser never sees, hand back plain rows.

   The contract is published in ANALYTICS-API.md and the dashboard is built
   against it. Changing a column name here is changing that file.

   --- THE THREE THINGS THAT MAKE THIS SAFE -------------------------------

   1. ADMIN IS VERIFIED HERE, NOT CLAIMED THERE.
      `js/auth.js` keeps an `adminFlag` and exposes `FBU.admin()`. That is a UI
      convenience — it decides whether a link is painted — and it is worth
      nothing as security: it is a variable in a browser anyone can set from a
      console. This function verifies a Firebase ID token against the project's
      signing keys and then RE-READS `customers/{uid}` itself, applying exactly
      the test auth.js applies (`admin === true || role === "admin"`). Client
      writes to that document are denied by firestore.rules, so the only writers
      are the Stripe webhook and the console.

   2. THE BROWSER CANNOT SEND A QUERY.
      Not HogQL, not SQL, not a column, not a table, not an ORDER BY. Accepting
      a query string from a page would be a data-exfiltration hole with extra
      steps: a read-only PostHog key still reads EVERYTHING in the project, so
      "the key is read-only" is not a defence. The seventeen query texts are string
      constants below. A caller sends a NAME and typed VALUES, and every value
      is checked against a character set that contains no quote, no backslash,
      no brace, no semicolon and no comma before it is placed into a query — and
      re-checked by `lit()` at the moment of placement, so a future edit that
      forgets to validate still cannot produce an injection.

   3. NO IDENTITY LEAVES THE FUNCTION, WITH THREE DELIBERATE EXCEPTIONS.
      There is no `SELECT *` in this file. Every column is named. Of the
      seventeen queries, FOURTEEN select no `distinct_id`, no `person_id`, no
      `$ip`, no email and no person property: people are counted with
      `count(DISTINCT person_id)` and the COUNT is returned. The one query that
      reads Firestore uses `count()` aggregations, which return a number without
      opening a document.

      `reader_activity`, `reader_dwell` AND `person_timeline` ARE THE
      EXCEPTIONS, AND THEY ARE ON PURPOSE. The owner asked to see "the emails
      / accounts and which stories they viewed, how far they got", then
      "dwell times per user on each page or card", then "one person did x
      then y then z and then an hour later" — with a handful of readers, an
      aggregate percentage says nothing and a list of people says
      everything. So three queries return one email per reader. The same
      four things keep all three narrow:

        * THE EMAIL NEVER COMES FROM POSTHOG. It is not there and must not be
          put there. PostHog knows the uid, because js/analytics.js calls
          identify(uid); Firebase Auth knows uid -> email. This function holds
          admin credentials for both and does the join itself, in memory, per
          request. Nothing is written anywhere.
        * THE UID NEVER REACHES THE BROWSER. Rows carry an opaque ordinal
          ("1", "2", ...) that is assigned per response and is not stable
          between two responses, so it cannot be used to follow anyone. It
          exists only so the dashboard can group a reader's story rows.

          AND IT IS ONE ORDINAL SPACE, NOT THREE. All three queries number
          readers off the SAME roster — reader_activity's query through
          foldReaders() — so "reader 5" is one person in every table on the
          page. This is also how `person_timeline` can be asked about a
          person without ever being told who: the browser sends the integer
          it was shown, and the resolution back to a person_id happens here,
          upstream, inside one request, and is discarded with it.
        * A READER WITH NO ACCOUNT STAYS ANONYMOUS. `email` is null and the
          behaviour is intact. Nothing is invented to fill the column.
        * IT IS BOUNDED AND IT IS LOGGED. A row cap on all three, a window
          ceiling on the timeline, most-recent-first ordering, and a log
          line naming the admin who asked — see READER_ROWS, DWELL_ROWS_MAX
          and TIMELINE_ROWS_MAX below, and the `insights personal` line in
          the endpoint, which for a timeline also records WHICH ordinal was
          asked for and whether it resolved.

      ANALYTICS-API.md 6 says the same thing in the contract, because a
      reader of that file must not conclude from fourteen queries that the
      other three are impossible.

      AND ONE THING THAT IS NOT RETURNED ANYWHERE. `geo_breakdown` reads
      PostHog's `$geoip_*` properties, which exist on every event, and
      returns COUNTS BY COUNTRY and nothing else — no city, no region, no
      timezone, no IP, and never a country beside a named individual. A
      country on a person's row is a location attached to a person and is a
      different promise to readers than a map is; privacy.html would need a
      different sentence before it could be added, and that file is not
      edited from here.

   4. THE ADMIN ACCOUNTS CAN BE TAKEN OUT, SERVER-SIDE, AND ARE BY DEFAULT.
      There are three accounts on this project and all three are founders'.
      Un-filtered, every number on the dashboard is mostly their own testing,
      which is worse than no number at the moment they are trying to read a
      launch. `exclude_admins` defaults to TRUE: the honest default is
      "numbers about strangers", and seeing your own traffic is the special
      case. The filter is built HERE, out of uids read HERE from `customers`,
      and the uids are never sent to the browser -- filtering in the page
      would ship them and would get the arithmetic wrong on anything
      aggregated, which is all of it.

   --- RATE LIMITING, AND WHY IT LOOKS LIKE support.js --------------------

   `functions/support.js` was rewritten because its throttle was a module-scope
   `Map`, which is per-instance: every cold start handed an attacker a fresh
   one and the real limit was `cap × instances`. The same trap is here and the
   same answer applies — the authoritative counters are Firestore documents,
   read and written inside one transaction, shared by every instance.

   Two things are simpler here than there. The caller is always an authenticated
   admin, so the counter keys on the uid and there is no IP to hash, no daily
   salt and no privacy cost at all. And the limits run AFTER the admin check, so
   an anonymous flood costs zero Firestore operations — a forged token fails on
   signature verification against cached public keys, before any network call
   and before any read.

   --- NODE 20 -----------------------------------------------------------

   `functions/package.json` pins `"node": "20"`, which Cloud Functions
   decommissions on 30 October 2026. Noted, not migrated: this file adds no
   dependency and uses nothing newer than global `fetch`, so it moves whenever
   the other four functions move, in one change, deliberately.
   ========================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* --- The credentials ----------------------------------------------------
   Both in Secret Manager. This repository is public, so neither may appear in
   a file, an env file, or a deploy script. The key is a PostHog PERSONAL API
   key scoped to `query:read` on the one project; the project id is the number
   in the PostHog dashboard URL. The id is not really a secret, but keeping it
   beside the key means there is exactly one place the owner has to look and
   exactly one thing that can be committed by accident: nothing.

   Unset, both read as "" and every PostHog-backed query answers `upstream`
   with `reason: "not_configured"`. That is deliberate — the same shape
   support.js uses for a missing mail key. The function deploys, the admin
   check works, the rate limits work, `subscription_totals` works. The owner
   turning the key on is the last step, not a prerequisite. */
const POSTHOG_API_KEY = defineSecret("POSTHOG_API_KEY");
const POSTHOG_PROJECT_ID = defineSecret("POSTHOG_PROJECT_ID");

/* js/analytics.js sends to us.i.posthog.com and links to us.posthog.com. The
   query API lives on the latter. Not configurable: a host that came from a
   request would be a way to post an admin's key to somebody else's server. */
const PH_HOST = "https://us.posthog.com";

/* --- Where the counters live ------------------------------------------- */
const RATE_COLLECTION = "insights_rate";     /* one doc per admin per UTC day */
const QUOTA_DOC = "insights_meta/quota";     /* today's global upstream count */

/* --- Caps ---------------------------------------------------------------
   Sized for a dashboard that paints a dozen panels and refreshes now and
   then. Generous for a human, stingy for a render loop, which is the point:
   the commonest way an analytics page costs money is a useEffect with a bad
   dependency array, not an attacker. */
/* Raised from 30/240 when the dashboard went from eleven panels to fourteen.
   A full render is fourteen requests; at 30 a minute an admin pressing Refresh
   twice while reading a launch would lock themselves out of their own numbers,
   which is a cap protecting nothing from anybody. Still stingy for a render
   loop, which is what the cap is actually for. */
const PER_ADMIN_PER_MIN = 60;
const PER_ADMIN_PER_HOUR = 480;
const PER_ADMIN_PER_DAY = 1000;
const GLOBAL_PER_DAY = 3000;                 /* upstream queries, all admins */

const MAX_BODY_BYTES = 8 * 1024;             /* the whole request, before parsing */
const UPSTREAM_TIMEOUT_MS = 20 * 1000;       /* inside a 30s function */
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;  /* a runaway result is not a row set */
const RATE_TTL_MS = 26 * 60 * 60 * 1000;     /* for a Firestore TTL policy */

/* Bounds on what a caller may ask for. `days` is the cost dial — ClickHouse
   scans by time — and 90 is already far more history than a story site with
   weeks of data has. `limit` bounds the response, not the scan; every query
   below carries it. */
const DAYS_MIN = 1, DAYS_MAX = 90, DAYS_DEFAULT = 14;
const LIMIT_MIN = 1, LIMIT_MAX = 200, LIMIT_DEFAULT = 50;
const MAX_MESSAGE_CHARS = 200;               /* client_error.message, truncated */

/* --- The admin-exclusion switch ----------------------------------------
   The uids are read from `customers` and cached for a minute. Without the
   cache a single render is seventeen panels x one collection scan; with it,
   one scan serves the whole render and the next one too. A minute is short
   enough that granting or revoking admin shows up on the next refresh but
   one, which is the right trade for a flag that changes about once a year. */
const ADMIN_CACHE_MS = 60 * 1000;
const RE_UID = /^[A-Za-z0-9_-]{1,64}$/;      /* a Firestore doc id we will quote */

/* --- reader_activity ----------------------------------------------------
   Rows are (person, distinct id, story) triples, ordered most recent first.
   The cap is the bound: this is for tens of people and it must refuse to
   melt rather than try, so the query asks for ONE MORE row than the caller
   wanted and the response says `truncated` when that extra row exists. */
const READER_ROWS_DEFAULT = 200;
const READER_ROWS_MAX = 400;
const AUTH_BATCH = 100;                      /* getUsers() takes 100 at a time */

/* --- reader_dwell -------------------------------------------------------
   One row per (person, page, story, card). A reader who works through a
   twenty-card story at two addresses is forty rows on their own, so the cap
   is its own and it is larger than reader_activity's. Measured on the live
   project on 6 September 2026: the WHOLE history — 90 days, 26 readers, 336
   card views, admins excluded — is 219 such rows. 300 is therefore a cap
   that does not bite today and 600 is the ceiling; when it does bite,
   `meta.truncated` is true and the per-reader totals nearest the cut are
   partial, which ANALYTICS-API.md says beside the query. */
const DWELL_ROWS_DEFAULT = 300;
const DWELL_ROWS_MAX = 600;

/* --- The dwell cap, and why there is one -------------------------------
   `dwell_s` is time a card was ON SCREEN. js/analytics.js already refuses to
   report anything under 900ms (a swipe) or over 30 minutes (a machine that
   went to sleep mid-card), so the raw values are bounded at 1800 — but 1800
   is still a tab somebody left open, and one of those is enough to own a
   mean. Nothing here reports a mean.

   Every dwell figure comes back twice: the raw sum, and a `_capped` sum in
   which each individual card view is first clipped to this many seconds.

   The number is measured, not chosen. Over the live project's whole history
   on 6 September 2026 — 336 card views, admins excluded — a single view's
   median is 3.0s, its 75th percentile 6.5s, its 90th 23.7s, its 95th 50.7s
   and its 99th 222.4s, with a longest of 923.6s. A 180s clip therefore
   touches a little over one view in a hundred and does not go near reading.

   AND THE SIZE OF WHAT IT REMOVES IS THE REASON THIS IS NOT OPTIONAL. Those
   few views are 21.5% of all the dwell on the site: 4,743 raw seconds
   against 3,725 capped, and 820 of the 1,018 seconds removed belong to ONE
   reader whose median card is 3.0s. A mean — at any grouping, over any
   window — would have been that person's abandoned tab wearing everybody
   else's name. Nothing here returns a mean. Both sums are returned and
   `meta.dwell_cap_s` states the clip, so the capped figure is a stated
   arithmetic rather than a number to be taken on trust. */
const DWELL_CAP_S = 180;

/* --- person_timeline ----------------------------------------------------
   One reader's events in time order. The most sensitive query in the file
   and the most tightly bounded: a row cap, a window ceiling, and an ordinal
   that has to be resolved against a roster before it names anybody.

   The window ceiling is measured, not guessed. This query filters on a
   PERSON rather than on an event name, so ClickHouse cannot use the event
   index and scans the window instead — the same shape of risk `event_volume`
   hit at 36 days. Measured end to end on 6 September 2026, both upstream
   calls plus the Firebase Auth join, on the live project: 1 day 101ms,
   7 days 845ms, 31 days 576-722ms, 90 days 590ms, and a 98-day from/to
   range 2282ms. Nothing near a timeout, because it returns one person's
   rows rather than grouping every person by day.

   31 DAYS IS KEPT AS THE CEILING ANYWAY, and the reason is not today's
   timings. The cost of this scan grows with the whole site's event volume
   while the answer stays one person's afternoon, so the query gets steadily
   more expensive to serve the same page; and a month is the window a human
   actually reads a timeline over. `meta.clamped_to_days` says when the
   ceiling moved the start date, so a caller asking for 90 is told it got
   31 rather than left to assume. */
const TIMELINE_ROWS_DEFAULT = 200;
const TIMELINE_ROWS_MAX = 500;
const TIMELINE_MAX_DAYS = 31;

/* A gap longer than this starts a new visit. Half an hour is the same
   convention every analytics tool uses for a session, and the timeline says
   `session` on every row so "then an hour later" is visible as a number and
   as a break, not inferred from two timestamps by whoever is reading. */
const SESSION_GAP_S = 30 * 60;

/* --- Where readers are --------------------------------------------------
   PostHog derives these from the IP at ingestion. The Cloudflare Worker in
   cloudflare/posthog-proxy.js sets X-Forwarded-For from CF-Connecting-IP,
   which is the line that makes them the READER's country rather than a
   Cloudflare colo — see the geo_breakdown query for what the live data
   actually says about that. Property names are PostHog's own and are
   constants in this file, never parameters. */
const GEO_UNKNOWN = "Unknown";

/* --- /firststory --------------------------------------------------------
   The cold-arrival URL the launch videos point at. It serves story 01, which
   is ALSO served at /read?s=01 and /cleopatra, so the story id alone cannot
   answer "how far did people get on the page the videos point at" — only
   `card_view.page` can, and that property is new. Both constants are here
   rather than in a parameter: a caller cannot ask this query about another
   page, because this panel is a named question about one URL. */
const FIRSTSTORY_PAGE = "firststory";
const FIRSTSTORY_STACK = "01";
/* The addresses story 01 is served at, so a card view of it can be told from
   an UNATTRIBUTED one — a view recorded before `page` shipped on card_view.
   Absence is not tested with `= ''`: a missing property is NULL in HogQL and
   NULL = '' is NULL, so counting absence that way silently returns zero. It
   is counted as a subtraction from the total instead. */
const STACK_01_PAGES = ["firststory", "read", "cleopatra"];
const FS_PERSON_ROWS = 5000;                 /* the per-person scan's own cap */

/* --- The quiz funnel's own bounds ---------------------------------------
   Every one of these is a cost bound on a scan, not a display limit, and
   none of them is reachable by a caller: the four onboarding queries take
   `days` and `exclude_admins`, and only onboarding_answers takes `limit` —
   which trims the ROWS RETURNED after the join, never the scan.

   PCT_MIN_PEOPLE is different in kind and is the reason it lives here
   rather than in js/dashboard.js. This product has almost no readers, and a
   funnel chart with n=3 that reads like a trend is the likeliest way this
   panel misleads its only reader. So THE FUNCTION decides whether a
   percentage may be printed and the page obeys it, exactly as geo_breakdown
   decides `geo_usable` and the map obeys that. A minimum-n constant in the
   page would be a second opinion, and two opinions about whether a number
   is real is how one of them ships wrong. */
const OB_PERSON_ROWS = 5000;    /* onboarding_conversion, one row per person */
const ANSWER_ROWS_MAX = 2000;   /* (person, q, answer) triples */
const OUTCOME_ROWS_MAX = 400;   /* the per-person outcome roster it joins to */
const RUN_ROWS_MAX = 1000;      /* onboarding_runs, one row per run */
const PCT_MIN_PEOPLE = 20;      /* below this, counts only — no percentages */

/* --- CORS ---------------------------------------------------------------
   The allowlist story.js and support.js already use. Not the security
   boundary — the token is — but there is no reason to let an arbitrary page
   make a signed-in admin's browser fetch this. */
const ALLOWED = ["https://factbox.app", "https://www.factbox.app"];

function originAllowed(origin) {
  if (!origin) return null;
  if (ALLOWED.indexOf(origin) !== -1) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/.test(origin)) return origin;
  return null;
}

function cors(req, res) {
  const ok = originAllowed(req.headers.origin);
  if (ok) res.set("Access-Control-Allow-Origin", ok);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "3600");
}

function send(res, status, body) {
  res.set("Cache-Control", "private, no-store");
  return res.status(status).type("application/json").send(JSON.stringify(body));
}

/* Four codes, and this list does not grow — ANALYTICS-API.md publishes it and
   the dashboard branches on it. `extra` carries advisory keys for a human
   reading the network tab; nothing may branch on those. */
function fail(res, code, extra) {
  const status = code === "not_admin" ? 403
               : code === "rate_limited" ? 429
               : code === "upstream" ? 502
               : 400;
  const body = { ok: false, error: code };
  if (extra) for (const k in extra) if (extra[k] !== undefined) body[k] = extra[k];
  return send(res, status, body);
}

/* ==========================================================================
   PARAMETERS

   Every one returns a value of a known type inside known bounds, or throws
   `bad_query` naming the field. Nothing downstream re-checks a type, because
   nothing downstream sees a value these did not produce.
   ========================================================================== */

function bad(field) {
  const e = new Error("bad_query");
  e.code = "bad_query";
  e.field = field;
  return e;
}

/* Clamped, not rejected. Asking for 400 days is a slider at its end, not an
   attack, and the clamped value is echoed in meta.params so the dashboard can
   say "showing 90 days" rather than lying about what it drew. */
function intParam(v, min, max, dflt, field) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : Number(String(v));
  if (!isFinite(n) || Math.floor(n) !== n) throw bad(field);
  return Math.min(max, Math.max(min, n));
}

/* A switch, not a value, so there is nothing to clamp and nothing to quote —
   it decides whether a clause is BUILT, and the clause is built out of uids
   this file read from Firestore. `true` and `"true"` and `1` all mean on,
   because a checkbox, a select and a curl each send it differently and none of
   them is wrong. Anything else is bad_query: a switch that silently reads a
   typo as "off" changes what every number on the page means. */
function boolParam(v, dflt, field) {
  if (v === undefined || v === null || v === "") return dflt;
  if (v === true || v === false) return v;
  if (v === 1 || v === "1" || v === "true" || v === "yes") return true;
  if (v === 0 || v === "0" || v === "false" || v === "no") return false;
  throw bad(field);
}

/* Rejected, not sanitised. A story id with a quote in it is not a typo — there
   is no such story — so silently stripping the quote would hide the attempt.
   Refusing it puts a line in the log with the uid that sent it. */
function strParam(v, re, field, optional) {
  if (v === undefined || v === null || v === "") {
    if (optional) return "";
    throw bad(field);
  }
  if (typeof v !== "string") throw bad(field);
  if (!re.test(v)) throw bad(field);
  return v;
}

const RE_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const RE_STORY = /^[A-Za-z0-9_-]{1,24}$/;
const RE_PAGE = /^[a-z0-9_]{1,40}$/;
const RE_CONTAINS = /^[A-Za-z0-9 _.:/-]{1,40}$/;
const RE_RELEASE = /^[A-Za-z0-9._-]{1,40}$/;

/* The last line of defence, and the only one that is structural.

   Everything reaching here has already matched one of the four expressions
   above, none of which admits a quote, a backslash, a brace, a semicolon, a
   comma, a parenthesis, a percent or a newline. This asserts that again at the
   point of use rather than trusting that it happened, so a future query that
   forgets to validate its parameter throws instead of building a query with a
   stranger's punctuation in it.

   PostHog does offer HogQL placeholders with a `values` map, which would be
   the more fashionable answer. This does not use them: the guarantee wanted
   here is "the value cannot contain a character that ends a string literal",
   which is a property of the value and holds whatever the upstream API does
   with it, rather than a property of a remote parser this code cannot see. */
function lit(s) {
  const v = String(s);
  if (!/^[A-Za-z0-9 _.:/-]*$/.test(v) || v.length > 64) {
    const e = new Error("bad_query");
    e.code = "bad_query";
    e.field = "value";
    throw e;
  }
  return "'" + v + "'";
}

/* The same, for the one place a wildcard is wanted. `%` is not in any
   parameter's character set — the guard above rejected it, correctly, when the
   first draft tried to build `'%' + contains + '%'` through lit() — so the
   wildcards are added HERE, by this file, around a value that still cannot
   contain one. A caller cannot smuggle a `%` in and turn an equality into a
   scan of everything. */
function likeLit(s) {
  const v = String(s);
  if (!/^[A-Za-z0-9 _.:/-]{1,40}$/.test(v)) {
    const e = new Error("bad_query");
    e.code = "bad_query";
    e.field = "contains";
    throw e;
  }
  return "'%" + v + "%'";
}

/* Integers are produced by intParam and clamped, so they are integers. This
   exists so that reading a query text below shows where a number goes. */
function num(n) {
  const v = Number(n);
  if (!isFinite(v) || Math.floor(v) !== v) {
    const e = new Error("bad_query");
    e.code = "bad_query";
    throw e;
  }
  return String(v);
}

/* Every event name js/analytics.js currently sends, plus `client_error`, which
   a second agent is adding to the same seam. `event_volume` will not ask for a
   name outside this list — not because an unknown name is dangerous (it is
   already charset-checked) but because "0 rows" for a typo is a worse answer
   than "that is not an event". When analytics.js gains an event, add it here. */
const KNOWN_EVENTS = [
  "access_gained", "annual_selected", "billing_portal", "card_view",
  "checkout_blocked", "checkout_start", "client_error",
  "first_completion_screen_viewed", "first_story_completed", "home_view",
  "join_login_hit", "join_login_known", "join_login_miss", "join_plan_answer",
  "join_plan_ask", "join_plan_built", "join_plan_pick", "join_plan_start",
  "join_restore_use", "join_signup", "join_skip", "join_step", "join_view",
  "library_own_view", "library_unsave", "monthly_selected",
  "other_plans_opened", "owner_unlock", "page_open", "paywall_view",
  "rec_click", "rec_view", "resume_used", "second_story_shown",
  "signin_email", "signin_google", "signout", "signup_email",
  "ob_answer", "ob_done", "ob_leave", "ob_step",
  "stack_complete", "stack_dropoff", "stack_open", "story_time",
  "subscribe_click", "trial_cta_clicked", "ui_click"
];

/* ==========================================================================
   THE QUERIES

   Seventeen. Each is a function of already-validated parameters returning
   { sql, columns } — `columns` is what the rows are called, so the response
   does not depend on PostHog echoing a column list back.

   Two conventions run through all of them:

     - `toInt(toString(properties.x))`, NOT `toIntOrNull(...)`: HogQL has no
       such function and rejects the whole query with a 400. HogQL's toInt()
       already returns null on a value it cannot parse, which is the
       behaviour toIntOrNull was reached for. Event
       properties arrive as JSON and a property that is a string on some events
       and a number on others is normal; a cast that throws takes the whole
       query down, and a NULL is a row this code can drop.

     - Every one carries a `timestamp >=` floor and a LIMIT. There is no query
       here that can scan the whole table or return an unbounded result.
   ========================================================================== */

/* The time window, as ClickHouse counts it. Two forms, and every query takes
   whichever the caller used.

   `days` is a relative floor — `toIntervalDay` over an integer this file
   clamped, so it never reaches here as text. `from`/`to` is an absolute range,
   which is what a dashboard with a date picker actually has; it arrives as two
   `YYYY-MM-DD` strings, is checked to be a real date, and is spanned-clamped to
   DAYS_MAX before it gets here. `to` is INCLUSIVE of its own day, because a
   person who picks 21 August to 4 September means both of those days. */
function since(p) {
  if (p.from && p.to) {
    return "timestamp >= toDateTime(" + lit(p.from + " 00:00:00") + ")" +
           " AND timestamp < toDateTime(" + lit(p.to + " 00:00:00") + ") + toIntervalDay(1)";
  }
  return "timestamp >= now() - toIntervalDay(" + num(p.days) + ")";
}

/* --- Taking the founders out of their own numbers -----------------------

   Appended to the WHERE of every PostHog-backed query. `p.adminUids` is put
   on the params by the ENDPOINT, from Firestore, after the admin check — a
   caller cannot send it, cannot see it, and cannot influence which uids are
   in it. Each one still goes through lit(), which re-asserts the character
   set at the point of placement, so a doc id that somehow held punctuation
   would throw rather than build a query with it.

   `distinct_id`, not `person_id`. js/analytics.js calls identify(uid), so a
   signed-in reader's distinct_id IS their Firebase uid, which is the only
   identifier this function can match against a Firestore document. The honest
   limit of that: events an admin sent BEFORE signing in on a device carry an
   anonymous distinct_id and are not removed, even though PostHog has stitched
   them to the same person. The founders sign in and stay signed in, so this
   is a rounding error rather than a hole — but it is a rounding error, not a
   guarantee, and ANALYTICS-API.md says so where a reader of a number will
   see it. Excluding by person_id would need a subquery over a table this file
   has never run against, and an untested HogQL construct takes the whole
   panel down rather than one row of it. */
/* The three addresses story 01 is served at, quoted one at a time through
   lit() like every other value this file places into a query. */
function pageList() {
  const parts = [];
  for (const n of STACK_01_PAGES) parts.push(lit(n));
  return parts.join(", ");
}

function notAdmins(p) {
  if (!p.excludeAdmins) return "";
  const ids = p.adminUids || [];
  if (!ids.length) return "";
  const parts = [];
  for (const u of ids) parts.push(lit(u));
  return "   AND distinct_id NOT IN (" + parts.join(", ") + ")";
}

/* --- The reader roster, written once and used twice ----------------------
   `reader_activity` returns it and `person_timeline` resolves an ordinal
   against it. They MUST be the same rows in the same order or the ordinal a
   dashboard printed resolves to a different person than the one it named,
   which is the worst failure this file could have. So there is one query
   text and one column list, and both queries call them. A second copy that
   drifted would not fail loudly — it would quietly show the wrong reader. */
const READER_COLUMNS = ["person", "reader", "story", "opens", "completions",
                        "cards_seen", "furthest_card", "last_seen"];

function rosterSql(p, rows) {
  return "SELECT person_id AS person," +
    " distinct_id AS reader," +
    " if(event = 'card_view', toString(properties.story)," +
    "   toString(properties.stack)) AS story," +
    " countIf(event = 'stack_open') AS opens," +
    " countIf(event = 'stack_complete') AS completions," +
    " count(DISTINCT if(event = 'card_view'," +
    "   toString(properties.card), NULL)) AS cards_seen," +
    " max(toInt(toString(properties.card))) AS furthest_card," +
    " max(timestamp) AS last_seen" +
    " FROM events" +
    " WHERE event IN ('stack_open', 'card_view', 'stack_complete', 'stack_dropoff')" +
    "   AND " + since(p) +
    notAdmins(p) +
    " GROUP BY person, reader, story" +
    " ORDER BY last_seen DESC LIMIT " + num(rows);
}

const QUERIES = {

  /* --- How each story does -------------------------------------------------
     `stack_open` is the deck rendering, `stack_complete` is reaching the end
     unlocked, `story_time` is engaged time — the clock stops when the tab
     hides, so a phone face-down in a pocket does not report an hour of
     reading. `median_last_card` is "where readers stop" as one number; the
     histogram behind it is `story_stop_points`. */
  story_performance: {
    params: ["exclude_admins", "days", "limit"],
    build: (p) => ({
      columns: ["story", "opens", "completions", "completion_pct", "readers",
                "median_dwell_s", "median_cards", "median_last_card"],
      sql:
        "SELECT properties.stack AS story," +
        " countIf(event = 'stack_open') AS opens," +
        " countIf(event = 'stack_complete') AS completions," +
        " round(100 * countIf(event = 'stack_complete')" +
        "   / greatest(countIf(event = 'stack_open'), 1), 1) AS completion_pct," +
        " count(DISTINCT person_id) AS readers," +
        " round(median(if(event = 'story_time'," +
        "   toFloatOrNull(toString(properties.dwell_ms)) / 1000, NULL)), 1) AS median_dwell_s," +
        " round(median(if(event = 'story_time'," +
        "   toFloatOrNull(toString(properties.cards)), NULL)), 1) AS median_cards," +
        " round(median(if(event IN ('stack_complete', 'stack_dropoff')," +
        "   toFloatOrNull(toString(properties.card)), NULL)), 1) AS median_last_card" +
        " FROM events" +
        " WHERE event IN ('stack_open', 'stack_complete', 'stack_dropoff', 'story_time')" +
        "   AND " + since(p) +
        "   AND toString(properties.stack) != ''" +
        notAdmins(p) +
        " GROUP BY story ORDER BY opens DESC LIMIT " + num(p.limit)
    })
  },

  /* --- Per-card fall-off, the one the owner described most precisely -------
     dwell is not derived here: `card_view` already carries `dwell_s`, and the
     event is only sent once a card has been on screen for 900ms or more — so
     these counts are attention rather than scroll position.

     NOTE THE PROPERTY NAME. card_view calls the story `story`; stack_open and
     story_time call it `stack`. That is a real inconsistency in
     js/analytics.js and this is the query that trips over it. Not worth
     changing there — renaming a property orphans the history behind it.

     reach_pct and dropoff_pct are computed in `shape()` below rather than in
     SQL. A window function would need the rows ordered and partitioned
     upstream to produce two numbers that are a subtraction; doing it here
     costs nothing and keeps the query text simple enough to read. */
  card_dropoff: {
    params: ["exclude_admins", "story", "days", "limit"],
    build: (p) => ({
      columns: ["story", "card", "views", "readers", "median_dwell_s"],
      sql:
        "SELECT toString(properties.story) AS story," +
        " toInt(toString(properties.card)) AS card," +
        " count() AS views," +
        " count(DISTINCT person_id) AS readers," +
        " round(median(toFloatOrNull(toString(properties.dwell_s))), 1) AS median_dwell_s" +
        " FROM events" +
        " WHERE event = 'card_view'" +
        "   AND " + since(p) +
        "   AND toInt(toString(properties.card)) IS NOT NULL" +
        (p.story ? "   AND toString(properties.story) = " + lit(p.story) : "") +
        notAdmins(p) +
        " GROUP BY story, card ORDER BY story ASC, card ASC LIMIT " + num(p.limit)
    })
  },

  /* --- The histogram of last cards ----------------------------------------
     A locked run is never a completion however far it scrolled, which is why
     `stopped` at the paywall card is usually the tallest bar in a gated
     story. `card` on these events is already deepest+1 — the card reached. */
  story_stop_points: {
    params: ["exclude_admins", "story", "days", "limit"],
    build: (p) => ({
      columns: ["story", "last_card", "stopped", "completed", "sessions"],
      sql:
        "SELECT toString(properties.stack) AS story," +
        " toInt(toString(properties.card)) AS last_card," +
        " countIf(event = 'stack_dropoff') AS stopped," +
        " countIf(event = 'stack_complete') AS completed," +
        " count() AS sessions" +
        " FROM events" +
        " WHERE event IN ('stack_dropoff', 'stack_complete')" +
        "   AND " + since(p) +
        "   AND toInt(toString(properties.card)) IS NOT NULL" +
        (p.story ? "   AND toString(properties.stack) = " + lit(p.story) : "") +
        notAdmins(p) +
        " GROUP BY story, last_card ORDER BY story ASC, last_card ASC LIMIT " + num(p.limit)
    })
  },

  /* --- The money path ------------------------------------------------------
     One aggregate scan producing one row, pivoted into seven steps by
     `shape()`. Two things ANALYTICS-API.md says out loud and this comment
     repeats because whoever edits it next needs both:

     STEP REACH, NOT A STRICT FUNNEL. Each number is distinct people who did
     the thing inside the window. It does not verify that the same person did
     step 4 after step 3. A true sequential funnel needs a person-level join
     over ordered events and costs a multiple of this; for a path this linear
     the two agree closely, and the label has to say which one it is.

     THE ORDER IS THE PRODUCT'S, NOT THE BRIEF'S. The brief said "signed in →
     reached Stripe → came back → account created". On the live site the
     account exists BEFORE checkout: client_reference_id on the Stripe URL is
     the Firebase uid, and `checkout_blocked` with why="no_uid" is exactly what
     fires when it does not. So account_created sits before reached_stripe. */
  subscribe_funnel: {
    params: ["exclude_admins", "days"],
    build: (p) => ({
      columns: ["locked_story", "gate_opened", "signed_in", "account_created",
                "reached_stripe", "came_back", "subscribed", "blocked"],
      sql:
        "SELECT" +
        " count(DISTINCT if(event = 'paywall_view', person_id, NULL)) AS locked_story," +
        " count(DISTINCT if(event = 'join_view', person_id, NULL)) AS gate_opened," +
        " count(DISTINCT if(event IN ('signin_email', 'signin_google')," +
        "   person_id, NULL)) AS signed_in," +
        " count(DISTINCT if(event IN ('signup_email', 'join_signup')," +
        "   person_id, NULL)) AS account_created," +
        " count(DISTINCT if(event = 'checkout_start', person_id, NULL)) AS reached_stripe," +
        " count(DISTINCT if(event = 'access_gained', person_id, NULL)) AS came_back," +
        " count(DISTINCT if(event = 'access_gained'" +
        "   AND toString(properties.from) = 'stripe', person_id, NULL)) AS subscribed," +
        " count(DISTINCT if(event = 'checkout_blocked', person_id, NULL)) AS blocked" +
        " FROM events" +
        " WHERE " + since(p) +
        "   AND event IN ('paywall_view', 'join_view', 'signin_email', 'signin_google'," +
        "     'signup_email', 'join_signup', 'checkout_start', 'access_gained'," +
        "     'checkout_blocked')" +
        notAdmins(p) +
        " LIMIT 1"
    })
  },

  /* --- Why a checkout never started ---------------------------------------
     Not a funnel step, a leak. `no_uid` is a signed-out reader reaching for a
     paid plan and is a product problem; `no_link` and `no_url` mean a payment
     link is misconfigured and should be zero. */
  checkout_blocks: {
    params: ["exclude_admins", "days", "limit"],
    build: (p) => ({
      columns: ["why", "plan", "blocks", "people"],
      sql:
        "SELECT toString(properties.why) AS why," +
        " toString(properties.plan) AS plan," +
        " count() AS blocks," +
        " count(DISTINCT person_id) AS people" +
        " FROM events" +
        " WHERE event = 'checkout_blocked' AND " + since(p) +
        notAdmins(p) +
        " GROUP BY why, plan ORDER BY blocks DESC LIMIT " + num(p.limit)
    })
  },

  /* --- How far through /join people get -----------------------------------
     join.html moves through five panes and names each one on `join_step`.
     They are returned in the order that file moves through them, held in
     JOIN_STEPS below rather than inferred from counts — an inferred order is
     right until the day a step gains traffic from somewhere else, and then it
     is silently wrong. `jn-done` is the finish. */
  onboarding_funnel: {
    params: ["exclude_admins", "days"],
    build: (p) => ({
      columns: ["step", "kind", "people", "events"],
      sql:
        "SELECT toString(properties.step) AS step," +
        " if(event = 'join_skip', 'skip', 'step') AS kind," +
        " count(DISTINCT person_id) AS people," +
        " count() AS events" +
        " FROM events" +
        " WHERE event IN ('join_step', 'join_skip') AND " + since(p) +
        "   AND toString(properties.step) != ''" +
        notAdmins(p) +
        " GROUP BY step, kind ORDER BY people DESC LIMIT 60"
    })
  },

  /* --- Every control, by name ---------------------------------------------
     `control` is the data-fbt name where a control has one, otherwise its id,
     name, data-k, its own static label or its first class — site copy in the
     repo, in every case. Nothing a reader typed can reach this field: the
     delegated listener never reads the value of an input.

     `contains` is matched with ILIKE, where `_` is a single-character
     wildcard. Control names are full of underscores, so searching `sub_why`
     also matches `subXwhy`. Harmless — and escaping it would mean a backslash
     in a string this file has spent three hundred lines keeping backslashes
     out of. */
  button_presses: {
    params: ["exclude_admins", "days", "contains", "page", "limit"],
    build: (p) => ({
      columns: ["control", "page", "presses", "people"],
      sql:
        "SELECT toString(properties.control) AS control," +
        " toString(properties.page) AS page," +
        " count() AS presses," +
        " count(DISTINCT person_id) AS people" +
        " FROM events" +
        " WHERE event = 'ui_click' AND " + since(p) +
        (p.page ? "   AND toString(properties.page) = " + lit(p.page) : "") +
        (p.contains
          ? "   AND toString(properties.control) ILIKE " + likeLit(p.contains)
          : "") +
        notAdmins(p) +
        " GROUP BY control, page ORDER BY presses DESC LIMIT " + num(p.limit)
    })
  },

  /* --- Sound ---------------------------------------------------------------
     The ambient-sound button in js/audio-reader.js carries no data-fbt, no id
     and no name, so ui_click records it by its first class — `fb-sound` — and
     the class is read BEFORE the toggle flips. Every tap therefore looks
     identical.

     So this can say how many people touched the sound and how often, and it
     CANNOT say how many turned it on versus muted it. The fix is one attribute
     from that file's paint(): data-fbt="sound_on" / "sound_off" mirroring
     aria-pressed. That file belongs to another hand, so it is requested, not
     edited, and until it lands the dashboard tile has to read "sound toggled". */
  /* Three control names, not one, and the reason matters.

     This query was first written against `fb-sound`, which never shipped: the
     click listener walks up to the nearest ancestor with an id, and that is
     #fb-rail, so every historical press was recorded as `fb_rail` — one
     undifferentiated number that could not say whether sound went on or off.
     js/audio-reader.js now sets data-fbt to the state the press PRODUCES, so
     new presses arrive as `sound_on` (a play) or `sound_off` (a mute).

     `fb_rail` is kept as its own column rather than folded into the total.
     Those taps are real presses and dropping them would understate use before
     the fix, but they cannot be split, and adding them to either side would
     invent a direction nobody measured. The dashboard shows them separately
     and says why. */
  audio_usage: {
    params: ["exclude_admins", "days"],
    build: (p) => ({
      columns: ["plays", "mutes", "undirected_legacy_taps",
                "sound_users", "readers", "story_opens"],
      sql:
        "SELECT" +
        " countIf(event = 'ui_click'" +
        "   AND toString(properties.control) = 'sound_on') AS plays," +
        " countIf(event = 'ui_click'" +
        "   AND toString(properties.control) = 'sound_off') AS mutes," +
        " countIf(event = 'ui_click'" +
        "   AND toString(properties.control) = 'fb_rail') AS undirected_legacy_taps," +
        " count(DISTINCT if(event = 'ui_click'" +
        "   AND toString(properties.control) IN ('sound_on','sound_off','fb_rail')," +
        "   person_id, NULL)) AS sound_users," +
        " count(DISTINCT if(event = 'stack_open', person_id, NULL)) AS readers," +
        " countIf(event = 'stack_open') AS story_opens" +
        " FROM events" +
        " WHERE " + since(p) + " AND event IN ('ui_click', 'stack_open')" +
        notAdmins(p) +
        " LIMIT 1"
    })
  },

  /* --- Crashes -------------------------------------------------------------
     Live before the event is. There is no error capture on the site yet; a
     second agent is adding window.onerror and unhandledrejection reporting
     through the same capture() seam. This assumes an event named
     `client_error` with string `message`, `source`, `page`, `release` and a
     numeric `line`. Until that ships this returns zero rows, which is the
     correct answer to "how many crashes" and not an error.

     `message` is truncated to 200 characters here, and two requests went back
     through the owner to whoever writes the client half: send the Error's
     `message` and not a serialised object (a thrown string can carry whatever
     was in scope, including something a reader typed), and send `source` as a
     path rather than a full URL (grouping is on the exact string, so a
     cache-busting query parameter turns one bug into fifty rows). */
  client_errors: {
    params: ["exclude_admins", "days", "contains", "release", "limit"],
    build: (p) => ({
      columns: ["message", "source", "line", "page", "release",
                "errors", "people", "last_seen"],
      sql:
        "SELECT substring(toString(properties.message), 1, " + num(MAX_MESSAGE_CHARS) + ") AS message," +
        " toString(properties.source) AS source," +
        " toInt(toString(properties.line)) AS line," +
        " toString(properties.page) AS page," +
        " toString(properties.release) AS release," +
        " count() AS errors," +
        " count(DISTINCT person_id) AS people," +
        " max(timestamp) AS last_seen" +
        " FROM events" +
        " WHERE event = 'client_error' AND " + since(p) +
        (p.release ? "   AND toString(properties.release) = " + lit(p.release) : "") +
        (p.contains
          ? "   AND toString(properties.message) ILIKE " + likeLit(p.contains)
          : "") +
        notAdmins(p) +
        " GROUP BY message, source, line, page, release" +
        " ORDER BY errors DESC LIMIT " + num(p.limit)
    })
  },

  /* --- One event, by day ---------------------------------------------------
     The escape hatch, bounded: any event the site sends, counted per day. The
     name has to be in KNOWN_EVENTS — not because an unknown one is dangerous,
     it is charset-checked either way, but because zero rows for a typo is a
     worse answer than "that is not an event". */
  /* Windowed harder than the rest, on purpose.

     This is the only query that groups by day across EVERY event of a name,
     with a distinct-person count per day — the widest scan on the page. At a
     36-day window it timed out upstream (502) while 14 days answered in
     903ms. So the range is clamped here rather than left to fail: a chart
     that refuses is worse than one that shows a shorter period and says so.

     The clamp is on this query alone. story_performance and reader_activity
     scan the same table over the same span and return in well under a second,
     because they group by story or by person rather than by day-and-person. */
  event_volume: {
    maxDays: 31,
    params: ["exclude_admins", "event", "days", "limit"],
    build: (p) => ({
      columns: ["day", "events", "people"],
      sql:
        "SELECT toString(toDate(timestamp)) AS day," +
        " count() AS events," +
        " count(DISTINCT person_id) AS people" +
        " FROM events" +
        " WHERE event = " + lit(p.event) + " AND " + since(p) +
        notAdmins(p) +
        " GROUP BY day ORDER BY day ASC LIMIT " + num(p.limit)
    })
  },

  /* --- Who read what, and how far -----------------------------------------
     THE ONE QUERY THAT RETURNS PERSONAL DATA. Read the fourth block at the
     top of this file before changing anything here.

     The owner asked to see "the emails / accounts and which stories they
     viewed, how far they got in terms of cards". With a handful of readers a
     completion percentage says nothing and a list of people says everything,
     so this exists — and it is deliberately the only exception to a rule the
     other fourteen queries keep.

     WHAT COMES BACK FROM POSTHOG IS NOT AN EMAIL. It is a person_id and a
     distinct_id. The email is joined on afterwards, in the endpoint, out of
     FIREBASE AUTH, because js/analytics.js calls identify(uid) and so a
     signed-in reader's distinct_id is their Firebase uid. PostHog does not
     hold an email, has never been sent one, and must not be.

     GROUPED BY PERSON AND BY DISTINCT ID, both. person_id is PostHog's
     stitched person, so the reading someone did signed out and the reading
     they did signed in are one row set; distinct_id is what carries the uid,
     so it is what the email is looked up from. The endpoint folds the second
     into the first and returns neither.

     ORDERED MOST RECENT FIRST, and asked for one row more than the caller
     wanted, so "there are more of these" is a fact rather than a guess. */
  reader_activity: {
    params: ["exclude_admins", "days", "limit"],
    personal: true,
    build: (p) => ({ columns: READER_COLUMNS, sql: rosterSql(p, p.limit + 1) })
  },

  /* --- One reader's session, in order --------------------------------------
     "one person did x then y then z and then an hour later someone else did
     that too" — the owner's own words, and the most valuable of the three
     things asked for. It is also the most sensitive thing in this file:
     everything else here is a count, and this is a person's afternoon.

     HOW A CALLER NAMES A READER, AND WHY IT IS NOT AN ID. The parameter is
     `reader`: the ORDINAL reader_activity already prints — "1", "2", "3".
     That ordinal is assigned per response and means nothing on its own, so
     it has to be resolved back to a person, and that resolution happens
     HERE, upstream, out of a roster this function builds. The browser sends
     an integer and receives events; no `person_id`, no `distinct_id` and no
     uid crosses the wire in either direction. This is the whole reason the
     query costs two upstream calls instead of one.

     THE ORDINAL IS AS OF A WINDOW, AND THE WINDOW HAS TO MATCH. The roster
     is reader_activity's own rows through reader_activity's own fold — the
     same SQL, the same grouping, the same sort — so identical parameters
     give identical ordinals. Different parameters give a different roster
     and therefore a different person, which is why `meta.reader_email` and
     `meta.reader_last_seen` come back on every response: the dashboard can
     show WHO it resolved to, and a human can see at a glance that it is
     still the row they clicked. Pass an absolute `from`/`to` rather than
     `days` and the roster stops moving underneath you entirely.

     AN ORDINAL PAST THE END OF THE ROSTER IS NOT AN ERROR. It is a race —
     a reader who was 7th when the table was drawn is 8th after somebody
     else reads a card. It answers 200 with no rows and
     `meta.reader_found: false`, because a 400 here would send a dashboard
     to an error state over a fact about time.

     WHAT IS IN A ROW, AND WHAT IS DELIBERATELY NOT. `detail` is assembled
     in shapeTimeline() from named properties — the story, the card, the
     page, the control's name, the funnel step. It never carries
     `client_error.message`: that string is the one field on any event that
     can hold something a reader typed, and a timeline is not the place to
     find that out. `client_errors` already reports it, grouped, where it is
     a bug report rather than a person's afternoon. The reader's COUNTRY is
     not here either, though PostHog holds it — `geo_breakdown` gives the
     owner geography as counts, and a country on this row would be a
     location attached to a named individual, which is a different promise
     to readers and needs a different sentence in privacy.html. One line
     adds it the day that sentence is written. */
  person_timeline: {
    maxDays: TIMELINE_MAX_DAYS,
    params: ["exclude_admins", "reader", "roster_limit", "days", "limit"],
    personal: true,
    twoStep: true,
    /* Step one: the roster, which is reader_activity's query verbatim. */
    build: (p) => ({ columns: READER_COLUMNS, sql: rosterSql(p, p.rosterLimit + 1) }),
    /* Step two: that person's events, most recent first, bounded twice — by
       the row cap here and by the window ceiling above. Ordered DESC and
       reversed in shaping, so a cap that bites drops the OLDEST events
       rather than the ones the owner opened the panel to see. */
    buildEvents: (p, personId) => ({
      columns: ["at", "event", "page", "story", "card", "dwell_s", "control",
                "step", "plan", "why", "via", "source", "line", "cards"],
      sql:
        "SELECT timestamp AS at," +
        " event AS event," +
        " ifNull(toString(properties.page), '') AS page," +
        " ifNull(toString(properties.story)," +
        "   ifNull(toString(properties.stack), '')) AS story," +
        " toInt(toString(properties.card)) AS card," +
        " toFloatOrNull(toString(properties.dwell_s)) AS dwell_s," +
        " ifNull(toString(properties.control), '') AS control," +
        " ifNull(toString(properties.step), '') AS step," +
        " ifNull(toString(properties.plan), '') AS plan," +
        " ifNull(toString(properties.why), '') AS why," +
        " ifNull(toString(properties.from), '') AS via," +
        " ifNull(toString(properties.source), '') AS source," +
        " toInt(toString(properties.line)) AS line," +
        " toInt(toString(properties.cards)) AS cards" +
        " FROM events" +
        /* toString(), because person_id is a UUID and the literal is a
           string. The value came from PostHog one call ago and still goes
           through lit(), which re-asserts the character set at the point of
           placement exactly as it does for a value a stranger sent. */
        " WHERE toString(person_id) = " + lit(personId) +
        "   AND " + since(p) +
        /* THE SITE'S OWN EVENTS ONLY. posthog-js also captures $pageview,
           $pageleave, $autocapture and $web_vitals, and on a live reader
           they outnumber everything js/analytics.js sends by roughly four
           to one: the first run of this query filled all 500 rows with
           three days of one person's $pageleave and reported itself
           truncated. Nothing is lost by dropping them — `page_open` is sent
           on every page of this site and carries the page's NAME, which
           $pageview does not — and a row cap spent on autocapture is a row
           cap not spent on the reading the panel exists to show.

           A literal `$` and a literal `%` in a query text this file wrote,
           which is a different thing from a `%` in a value somebody sent:
           likeLit() exists because a caller must not be able to turn an
           equality into a scan, and no caller can reach this string. */
        "   AND event NOT LIKE '$%'" +
        notAdmins(p) +
        " ORDER BY at DESC LIMIT " + num(p.limit + 1)
    })
  },

  /* --- How far people scroll on /firststory --------------------------------
     The launch panel, and the graph the owner asked for by name: how many
     people reached each card of the story the videos point at.

     WHY THIS IS NOT `card_dropoff` WITH A STORY. Story 01 is served at THREE
     addresses — /read?s=01, /cleopatra and /firststory — and every one of
     them reports story `01`. Filtering on the story answers "how far did
     people get in Cleopatra", which is a different question from "how far did
     people get on the page the videos point at", and answering the second
     with the first would have been the kind of wrong that looks right.

     So it filters on `card_view.page`, which is a NEW property on an existing
     event. Two consequences, both of which the dashboard prints:

       * It cannot be backfilled. Card views recorded before that shipped
         carry no page and are not in here at all. `firststory_funnel` counts
         them, so the gap is a number on screen rather than a silence.
       * Zero rows before the client is pushed to readers is the correct
         answer, not a broken query. */
  firststory_cards: {
    params: ["exclude_admins", "days", "limit"],
    build: (p) => ({
      columns: ["card", "views", "people", "median_dwell_s"],
      sql:
        "SELECT toInt(toString(properties.card)) AS card," +
        " count() AS views," +
        " count(DISTINCT person_id) AS people," +
        " round(median(toFloatOrNull(toString(properties.dwell_s))), 1) AS median_dwell_s" +
        " FROM events" +
        " WHERE event = 'card_view'" +
        "   AND " + since(p) +
        "   AND toString(properties.page) = " + lit(FIRSTSTORY_PAGE) +
        "   AND toInt(toString(properties.card)) IS NOT NULL" +
        notAdmins(p) +
        " GROUP BY card ORDER BY card ASC LIMIT " + num(p.limit)
    })
  },

  /* --- Arrived at /firststory, then what -----------------------------------
     ONE ROW PER PERSON, AND NOT ONE OF THEM LEAVES THIS FUNCTION. The rows
     are folded into funnel steps by shapeFirstStory() and the person ids are
     dropped there. This is the shape it has to be: the owner asked "of the
     people who reached the end, how many signed up", and that is a question
     about the SAME person doing two things, which a table of totals cannot
     answer however it is sliced. subscribe_funnel is honest about being step
     reach rather than a sequential funnel; this one is not step reach, it is
     a cohort, and the difference is the whole point of it.

     THE COHORT is "opened /firststory, or read a card there". Every step
     below is counted only inside it, so "signed in" here means "signed in,
     having been on /firststory in this window" — not the site total.

     WHAT THIS CANNOT SAY, and the dashboard says it instead of implying
     otherwise: whether the end card they saw was the SIGN-UP ASK. On
     /firststory the end card is built with `cta: "Sign up to read more"`
     (firststory.html line 14), which suppresses the countdown and puts a
     sign-up control where "Start now" would be. NOTHING SENDS THAT.
     `rec_view` carries `stack` and `n`; `first_completion_screen_viewed`
     carries `stack` and `mins`; neither carries the cta and neither carries
     the page. So `reached_the_end` is "reached the end card of story 01,
     having been on /firststory" — an attribution by person, which is as close
     as the instrumentation allows and is labelled as exactly that. The fix is
     one property on one event; DASHBOARD.md asks for it.

     `end_built` is the end card being CONSTRUCTED, which firststory.html does
     a dozen cards before anyone reaches it. It is reported separately and is
     never presented as a view. */
  firststory_funnel: {
    params: ["exclude_admins", "days"],
    build: (p) => ({
      columns: ["person", "arrivals", "cards_here", "furthest_card",
                "cards_story", "cards_story_placed", "finished_story",
                "end_built", "end_seen", "gate", "signed_any", "signed_in",
                "account", "stripe", "subscribed", "days_active", "home_opens"],
      sql:
        "SELECT person_id AS person," +
        " countIf(event = 'page_open'" +
        "   AND toString(properties.page) = " + lit(FIRSTSTORY_PAGE) + ") AS arrivals," +
        " countIf(event = 'card_view'" +
        "   AND toString(properties.page) = " + lit(FIRSTSTORY_PAGE) + ") AS cards_here," +
        " max(if(event = 'card_view'" +
        "   AND toString(properties.page) = " + lit(FIRSTSTORY_PAGE) + "," +
        "   toInt(toString(properties.card)), NULL)) AS furthest_card," +
        " countIf(event = 'card_view'" +
        "   AND toString(properties.story) = " + lit(FIRSTSTORY_STACK) + ") AS cards_story," +
        " countIf(event = 'card_view'" +
        "   AND toString(properties.story) = " + lit(FIRSTSTORY_STACK) +
        "   AND toString(properties.page) IN (" + pageList() + ")) AS cards_story_placed," +
        " countIf(event = 'stack_complete'" +
        "   AND toString(properties.stack) = " + lit(FIRSTSTORY_STACK) + ") AS finished_story," +
        " countIf(event = 'rec_view'" +
        "   AND toString(properties.stack) = " + lit(FIRSTSTORY_STACK) + ") AS end_built," +
        " countIf(event = 'first_completion_screen_viewed'" +
        "   AND toString(properties.stack) = " + lit(FIRSTSTORY_STACK) + ") AS end_seen," +
        " countIf(event = 'join_view') AS gate," +
        /* One step, as the question was asked: "signed in or made an
           account". They cannot be split honestly — login.html fires
           `signin_google` for a new account and a returning one alike, so
           counting sign-ups separately undercounts by every Google sign-up.
           ANALYTICS.md 4 item 2 has the one-line fix. The split is returned
           anyway, as context rows the panel labels for what they are. */
        " countIf(event IN ('signin_email', 'signin_google'," +
        "   'signup_email', 'join_signup')) AS signed_any," +
        " countIf(event IN ('signin_email', 'signin_google')) AS signed_in," +
        " countIf(event IN ('signup_email', 'join_signup')) AS account," +
        " countIf(event = 'checkout_start') AS stripe," +
        " countIf(event = 'access_gained'" +
        "   AND toString(properties.from) = 'stripe') AS subscribed," +
        /* RETENTION, and it needs a definition rather than a feeling. "Came
           back later" is: a day, counted as a calendar day in UTC, on which
           this person did anything at all — so more than one of them means
           at least one visit later than their first. page_open is in the
           WHERE for every page precisely so that a return to the home page
           counts as coming back, which is what was asked. */
        " count(DISTINCT toString(toDate(timestamp))) AS days_active," +
        " countIf(event = 'page_open'" +
        "   AND toString(properties.page) = 'home') AS home_opens" +
        " FROM events" +
        " WHERE " + since(p) +
        "   AND (event = 'page_open'" +
        "     OR (event = 'card_view'" +
        "         AND toString(properties.story) = " + lit(FIRSTSTORY_STACK) + ")" +
        "     OR (event IN ('stack_complete', 'rec_view', 'first_completion_screen_viewed')" +
        "         AND toString(properties.stack) = " + lit(FIRSTSTORY_STACK) + ")" +
        "     OR event IN ('join_view', 'signin_email', 'signin_google'," +
        "       'signup_email', 'join_signup', 'checkout_start', 'access_gained'))" +
        notAdmins(p) +
        " GROUP BY person" +
        " ORDER BY arrivals DESC, cards_here DESC LIMIT " + num(FS_PERSON_ROWS)
    })
  },

  /* --- Where the readers are ----------------------------------------------
     The owner asked "what country they are from". PostHog can answer that
     only if it ever sees the reader's IP, and on this site it does not see
     it directly: every event goes through the Cloudflare Worker in
     cloudflare/posthog-proxy.js, so the connection PostHog terminates is
     Cloudflare's. THE ANSWER DEPENDS ENTIRELY ON ONE LINE OF THAT WORKER —
     `headers.set("X-Forwarded-For", ip)` from CF-Connecting-IP. Without it
     every reader on earth is one datacentre and this panel is a lie drawn
     as a map.

     It is there, and the live data says it works: the check is in
     ANALYTICS-API.md under this query, with the countries it returned. If
     that ever stops being true the symptom is unmistakable — one row, or
     one row plus Unknown — and the panel has to come off the page rather
     than be relabelled.

     WHAT IS NOT RETURNED. Not the city, not the region, not the timezone,
     not the IP, and not a country per person. A country beside a row of one
     person's reading is a location attached to an individual; a country
     with a count beside it is a map. PostHog holds the finer fields and
     this file does not ask for them.

     THE UNKNOWN ROW IS A ROW. Events recorded when geolocation failed, or
     from a reader whose IP resolved to nothing, are counted and labelled
     rather than dropped: a map whose percentages quietly exclude the people
     it could not place is the same lie in a smaller font. */
  geo_breakdown: {
    params: ["exclude_admins", "days", "limit"],
    build: (p) => ({
      columns: ["country", "country_code", "people", "opens",
                "page_opens", "card_views"],
      sql:
        "SELECT ifNull(toString(properties.$geoip_country_name), '') AS country," +
        " ifNull(toString(properties.$geoip_country_code), '') AS country_code," +
        " count(DISTINCT person_id) AS people," +
        " countIf(event = 'stack_open') AS opens," +
        " countIf(event = 'page_open') AS page_opens," +
        " countIf(event = 'card_view') AS card_views" +
        " FROM events" +
        " WHERE event IN ('page_open', 'stack_open', 'card_view')" +
        "   AND " + since(p) +
        notAdmins(p) +
        " GROUP BY country, country_code" +
        " ORDER BY people DESC, opens DESC LIMIT " + num(p.limit)
    })
  },

  /* --- How long each reader spent on each card ----------------------------
     "dwell times per user on each page or card", which is the owner's own
     phrasing and is two groupings at once: per reader, and per card at the
     address they read it on.

     PERSONAL, like reader_activity, and for the same reason and with the
     same four protections — the email is joined out of Firebase Auth in
     this function, the uid never reaches the browser, a reader with no
     account stays anonymous, and it is capped and logged. Read the third
     block at the top of this file before changing anything here.

     GROUPED BY PAGE AS WELL AS STORY. Story 01 is served at three
     addresses. "How long did this reader spend on card 7" has a different
     answer on /firststory than on /cleopatra, and folding the two together
     would average a cold arrival with a browse.

     THE AVERAGE IS THE TRAP, so there is no average. sum() for the total a
     reader actually spent, median() for the typical card, max() for the
     longest single view, and a second sum in which each view is first
     clipped to DWELL_CAP_S. A mean over dwell is one abandoned tab away
     from being fiction and is not returned at any grouping. */
  reader_dwell: {
    params: ["exclude_admins", "story", "page", "roster_limit", "days", "limit"],
    personal: true,
    /* TWO UPSTREAM QUERIES, AND THE SECOND ONE IS THE POINT.

       `reader` has to mean the same person in every query that prints it, or
       a dashboard where clicking a row in one table opens a timeline in
       another is showing one reader's afternoon under another reader's
       heading. The first draft here folded card_view rows and numbered them
       itself, which produced a SECOND ordinal space: reader_activity ranks
       everyone who opened a story, this ranks everyone who was measured
       reading a card, and a person who opened a story without a card view
       being recorded shifts every ordinal after them by one. Two tables,
       both labelled "reader 5", two different people, and nothing on screen
       to say so.

       So this asks for the roster first — reader_activity's own query,
       through reader_activity's own fold — and labels its rows with the
       ordinal that roster gives. One ordinal space across reader_activity,
       reader_dwell and person_timeline. It costs one extra PostHog query,
       which is why spendBudget() counts upstream calls rather than
       requests. */
    twoStep: true,
    build: (p) => ({ columns: READER_COLUMNS, sql: rosterSql(p, p.rosterLimit + 1) }),
    buildDwell: (p) => ({
      columns: ["person", "reader", "page", "story", "card", "views",
                "dwell_s", "dwell_s_capped", "median_dwell_s",
                "longest_dwell_s", "last_seen"],
      sql:
        "SELECT person_id AS person," +
        " distinct_id AS reader," +
        " ifNull(toString(properties.page), '') AS page," +
        " toString(properties.story) AS story," +
        " toInt(toString(properties.card)) AS card," +
        " count() AS views," +
        " round(sum(toFloatOrNull(toString(properties.dwell_s))), 1) AS dwell_s," +
        " round(sum(least(toFloatOrNull(toString(properties.dwell_s))," +
        "   " + num(DWELL_CAP_S) + ")), 1) AS dwell_s_capped," +
        " round(median(toFloatOrNull(toString(properties.dwell_s))), 1) AS median_dwell_s," +
        " round(max(toFloatOrNull(toString(properties.dwell_s))), 1) AS longest_dwell_s," +
        " max(timestamp) AS last_seen" +
        " FROM events" +
        " WHERE event = 'card_view'" +
        "   AND " + since(p) +
        "   AND toInt(toString(properties.card)) IS NOT NULL" +
        (p.story ? "   AND toString(properties.story) = " + lit(p.story) : "") +
        (p.page ? "   AND toString(properties.page) = " + lit(p.page) : "") +
        notAdmins(p) +
        " GROUP BY person, reader, page, story, card" +
        " ORDER BY last_seen DESC LIMIT " + num(p.limit + 1)
    })
  },


  /* ======================================================================
     THE QUIZ FUNNEL — four queries, five upstream calls

     js/onboard.js is the engine and it fires four events: ob_step (a screen
     was committed to the display), ob_answer (an option was chosen),
     ob_leave (a screen ended, and how) and ob_done (the flow reached its
     terminus). ONBOARDING-ANALYTICS.md is the specification; these are the
     queries it names, under the names it reserved, because
     `onboarding_funnel` and its alias `onboarding` belong to /join's five
     panes and must be left alone while join.html still fires join_step.

     THE SCREEN LIST IS DECLARED HERE AND IT IS NOT INFERRED. OB_STEPS below
     is a verbatim copy of FBOB.SCREENS in js/onboard.js and
     tools/check-analytics.js fails the build when the two drift. That is not
     tidiness: a step nobody reached returns NO ROW from PostHog, so a funnel
     built from the rows narrows silently instead of showing a gap, and a
     step inserted into the engine without being inserted here relabels every
     row below it. The engine's list is thirteen long — q_genres was added at
     position 6 after the spec was written — and this list is thirteen long
     for that reason and no other.
     ====================================================================== */

  /* id, kind and declared position — the three fields FBOB.SCREENS carries,
     in its order — plus the label this API prints. The first three columns
     are the contract the check compares; the fourth is ours. */
  /* (declared as OB_STEPS below the QUERIES table, beside JOIN_STEPS.) */

  /* --- Per screen: how far people get, how long they stay, which way they
         left ---------------------------------------------------------------
     ONE row per screen, folded from two events. `views`, `runs` and `people`
     are three different denominators and all three are returned, because
     they answer three different questions and a panel that silently picks
     one is a panel that argues with itself: a reader who goes back to
     q_draw and forward again is two views, one run and one person.

     DWELL HERE IS NOT CARD DWELL. js/analytics.js refuses a card_view under
     900ms; ob_leave has no floor at all, on purpose, because the affirmation
     screens are designed to be dismissed in well under a second and a floor
     deletes the exact measurement being asked for. The two numbers are
     measured under different rules and must never be added or compared —
     which is a sentence the dashboard prints rather than a rule it keeps in
     its head. The 30-minute ceiling IS inherited, and it is applied in the
     browser: over it, ob_leave is not sent at all.

     `dwell_s_capped` clips each individual screen view to DWELL_CAP_S before
     summing, the reader_dwell convention, because no mean is returned
     anywhere and a raw sum can be owned by one tab somebody left open. */
  onboarding_steps: {
    params: ["exclude_admins", "days"],
    build: (p) => ({
      columns: ["step", "kind", "views", "runs", "people", "forwards", "backs",
                "skips", "exits", "dwell_s", "dwell_s_capped", "median_dwell_s"],
      sql:
        "SELECT toString(properties.step) AS step," +
        " toString(properties.kind) AS kind," +
        " countIf(event = 'ob_step') AS views," +
        " count(DISTINCT if(event = 'ob_step'," +
        "   toString(properties.run), NULL)) AS runs," +
        " count(DISTINCT if(event = 'ob_step', person_id, NULL)) AS people," +
        " countIf(event = 'ob_leave'" +
        "   AND toString(properties.why) = 'forward') AS forwards," +
        " countIf(event = 'ob_leave'" +
        "   AND toString(properties.why) = 'back') AS backs," +
        " countIf(event = 'ob_leave'" +
        "   AND toString(properties.why) = 'skip') AS skips," +
        " countIf(event = 'ob_leave'" +
        "   AND toString(properties.why) IN ('exit_back', 'away')) AS exits," +
        " round(sum(if(event = 'ob_leave'," +
        "   toFloatOrNull(toString(properties.dwell_ms)) / 1000, NULL)), 1) AS dwell_s," +
        " round(sum(if(event = 'ob_leave'," +
        "   least(toFloatOrNull(toString(properties.dwell_ms)) / 1000," +
        "     " + num(DWELL_CAP_S) + "), NULL)), 1) AS dwell_s_capped," +
        " round(median(if(event = 'ob_leave'," +
        "   toFloatOrNull(toString(properties.dwell_ms)) / 1000, NULL)), 1) AS median_dwell_s" +
        " FROM events" +
        " WHERE event IN ('ob_step', 'ob_leave')" +
        "   AND " + since(p) +
        "   AND toString(properties.step) != ''" +
        notAdmins(p) +
        /* FIXED, not p.limit. The screen set is closed and thirteen long, so
           there is nothing here for a caller to widen — the same reason
           onboarding_funnel's LIMIT is fixed at 60. */
        " GROUP BY step, kind ORDER BY people DESC LIMIT 60"
    })
  },

  /* --- The whole ladder, and the comparison the owner actually asked for --
     PER PERSON, not one wide aggregate row, and that is a deliberate
     departure from ONBOARDING-ANALYTICS.md §4, which said to mirror
     subscribe_funnel. The question is "how do the BOTH perform" — the quiz
     against no quiz — and a single aggregate row cannot answer it: it can
     say how many people reached the paywall and how many people saw the
     quiz, and it cannot say whether they were the same people. One row per
     person can, from the same scan, at the same cost. This is the
     firststory_funnel shape and shapeOnboarding() folds it exactly the way
     shapeFirstStory() does.

     FIVE QUESTION RUNGS, NOT FOUR. The spec's ladder predates q_genres. The
     engine asks draw, relates, genres, goal and streak, in that order, and
     the ladder follows the engine.

     THE PERSON ID LIVES IN THIS BLOCK AND IN NO RESPONSE. Check that again
     after editing; shapeOnboarding() drops it and it is the whole of the
     privacy design here. */
  onboarding_conversion: {
    params: ["exclude_admins", "days"],
    build: (p) => ({
      columns: ["person", "ob_events", "opened", "q1_shown", "q1_answered",
                "q2_answered", "q3_answered", "q4_answered", "q5_answered",
                "pick_shown", "picked", "loader", "results", "finished",
                "account_screen", "join_gate", "signed_any", "account_created",
                "paywall_screen", "paywall_hit", "plan_picked", "stripe",
                "came_back", "subscribed", "blocked", "days_active"],
      sql:
        "SELECT person_id AS person," +
        " countIf(event IN ('ob_step', 'ob_answer', 'ob_done')) AS ob_events," +
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.step) = 'welcome') AS opened," +
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.step) = 'q_draw') AS q1_shown," +
        " countIf(event = 'ob_answer'" +
        "   AND toString(properties.q) = 'draw') AS q1_answered," +
        " countIf(event = 'ob_answer'" +
        "   AND toString(properties.q) = 'relates') AS q2_answered," +
        " countIf(event = 'ob_answer'" +
        "   AND toString(properties.q) = 'genres') AS q3_answered," +
        " countIf(event = 'ob_answer'" +
        "   AND toString(properties.q) = 'goal') AS q4_answered," +
        " countIf(event = 'ob_answer'" +
        "   AND toString(properties.q) = 'streak') AS q5_answered," +
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.step) = 'pick_story') AS pick_shown," +
        " countIf(event = 'ob_answer'" +
        "   AND toString(properties.q) = 'story') AS picked," +
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.step) = 'building') AS loader," +
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.step) = 'results') AS results," +
        " countIf(event = 'ob_done') AS finished," +
        /* account and paywall are declared screens that another surface
           owns. Nothing fires them today, which is a finding rather than a
           zero, and shapeOnboarding() reports the two surfaces split. */
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.step) = 'account') AS account_screen," +
        " countIf(event = 'join_view') AS join_gate," +
        /* One rung, as ANALYTICS.md 4 item 2 says it has to be:
           login.html fires signin_google for a new account and a returning
           one alike, so "made an account" is undercounted by every Google
           sign-up and is reported below as context rather than as a rung. */
        " countIf(event IN ('signin_email', 'signin_google'," +
        "   'signup_email', 'join_signup')) AS signed_any," +
        " countIf(event IN ('signup_email', 'join_signup')) AS account_created," +
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.step) = 'paywall') AS paywall_screen," +
        " countIf(event = 'paywall_view') AS paywall_hit," +
        " countIf(event IN ('subscribe_click', 'join_plan_pick')) AS plan_picked," +
        " countIf(event = 'checkout_start') AS stripe," +
        " countIf(event = 'access_gained') AS came_back," +
        " countIf(event = 'access_gained'" +
        "   AND toString(properties.from) = 'stripe') AS subscribed," +
        " countIf(event = 'checkout_blocked') AS blocked," +
        /* The same definition firststory_funnel uses, deliberately, so the
           two panels agree about what "came back" means: more than one
           calendar day in UTC with any event on it, inside this window. */
        " count(DISTINCT toString(toDate(timestamp))) AS days_active" +
        " FROM events" +
        " WHERE " + since(p) +
        "   AND event IN ('ob_step', 'ob_answer', 'ob_done', 'join_view'," +
        "     'paywall_view', 'signin_email', 'signin_google', 'signup_email'," +
        "     'join_signup', 'subscribe_click', 'join_plan_pick'," +
        "     'checkout_start', 'access_gained', 'checkout_blocked')" +
        notAdmins(p) +
        " GROUP BY person" +
        " ORDER BY ob_events DESC LIMIT " + num(OB_PERSON_ROWS)
    })
  },

  /* --- Which answers, and whether the people who gave them converted ------
     TWO UPSTREAM CALLS, the reader_dwell pattern, and the join is done in
     JS on person_id. One HogQL query cannot both group by (q, answer) and
     carry a per-person outcome without a window function or an array
     aggregate, and functions/insights.js has one rule about those: an
     untested HogQL construct takes the WHOLE panel down rather than one row
     of it. Two bounded queries and a Map is the boring answer.

     THE OUTCOME COLUMNS COUNT INSIDE THIS WINDOW ONLY. Somebody who
     answered on day 1 of a fortnight and paid on day 20 is `subscribed: 0`
     here and is not a lost sale. At this traffic these percentages are
     descriptive and never predictive, and the panel says so rather than
     offering them as a reason to change a question.

     NOTHING A READER TYPED IS IN `answer`. It is a key from a vocabulary
     js/account.js owns — DRAWS, RELATES, the genre keys, GOALS, STREAKS —
     or a catalogue story id, and a multi-select arrives as those keys
     sorted and joined with "|". There is no text box in this flow, and if
     one is ever added the rule is `answer:"other"` and nothing else. */
  onboarding_answers: {
    params: ["exclude_admins", "days", "limit"],
    twoUpstream: true,
    build: (p) => ({
      columns: ["person", "q", "answer", "answers", "runs"],
      sql:
        "SELECT person_id AS person," +
        " toString(properties.q) AS q," +
        " toString(properties.answer) AS answer," +
        " count() AS answers," +
        " count(DISTINCT toString(properties.run)) AS runs" +
        " FROM events" +
        " WHERE event = 'ob_answer'" +
        "   AND " + since(p) +
        "   AND toString(properties.q) != ''" +
        notAdmins(p) +
        " GROUP BY person, q, answer" +
        " ORDER BY answers DESC LIMIT " + num(ANSWER_ROWS_MAX)
    }),
    buildOutcomes: (p) => ({
      columns: ["person", "finished", "account", "stripe", "subscribed"],
      sql:
        "SELECT person_id AS person," +
        " countIf(event = 'ob_done') AS finished," +
        " countIf(event IN ('signin_email', 'signin_google'," +
        "   'signup_email', 'join_signup')) AS account," +
        " countIf(event = 'checkout_start') AS stripe," +
        " countIf(event = 'access_gained'" +
        "   AND toString(properties.from) = 'stripe') AS subscribed" +
        " FROM events" +
        " WHERE " + since(p) +
        "   AND event IN ('ob_done', 'signin_email', 'signin_google'," +
        "     'signup_email', 'join_signup', 'checkout_start', 'access_gained')" +
        notAdmins(p) +
        " GROUP BY person" +
        " ORDER BY finished DESC LIMIT " + num(OUTCOME_ROWS_MAX)
    })
  },

  /* --- Runs: abandoned, resumed, finished — and on which build -----------
     THE RUN IS WHY ANY OF THE PERCENTAGES ABOVE MEAN ANYTHING. DASHBOARD.md
     item 11: nothing on this site opens or closes a session, so without a
     run id one person's three attempts are one denominator and every
     drop-off figure is wrong. js/onboard.js mints an eight-character random
     string per run and puts it on all four events.

     BUCKETING HAPPENS IN shapeOnboardingRuns(), NOT IN SQL. A HogQL
     subquery is an untested construct here and the rule above applies.

     `release` IS THE BUILD MARKER, AND IT IS NOT A NEW PROPERTY NAME.
     js/analytics.js has carried a RELEASE constant and put it on
     client_error since before this panel existed, so `release` is a
     property name GA4 has already registered and this costs none of the
     remaining twenty-two. It is on ob_step only, it is at most forty
     characters of [A-Za-z0-9._-], and it is what makes "the onboarding
     changed twice and he may revert the motion" a question with an answer:
     runs split by the build they ran on. min() rather than any(): a run
     that spans a deploy started on the earlier build, and that is the true
     answer for a run. */
  onboarding_runs: {
    params: ["exclude_admins", "days"],
    build: (p) => ({
      columns: ["run", "person", "screens", "furthest_n", "resumed",
                "finished", "total_s", "first_day", "last_day", "release"],
      sql:
        "SELECT toString(properties.run) AS run," +
        /* Carried so people can be counted per bucket, and dropped by
           shapeOnboardingRuns() before anything is sent. */
        " min(toString(person_id)) AS person," +
        " count(DISTINCT if(event = 'ob_step'," +
        "   toString(properties.step), NULL)) AS screens," +
        " max(toInt(toString(properties.n))) AS furthest_n," +
        " countIf(event = 'ob_step'" +
        "   AND toString(properties.state) = 'resume') AS resumed," +
        " countIf(event = 'ob_done') AS finished," +
        " round(sum(if(event = 'ob_leave'," +
        "   toFloatOrNull(toString(properties.dwell_ms)) / 1000, NULL)), 1) AS total_s," +
        " min(toString(toDate(timestamp))) AS first_day," +
        " max(toString(toDate(timestamp))) AS last_day," +
        " min(if(event = 'ob_step'," +
        "   toString(properties.release), NULL)) AS release" +
        " FROM events" +
        " WHERE event IN ('ob_step', 'ob_answer', 'ob_leave', 'ob_done')" +
        "   AND " + since(p) +
        "   AND toString(properties.run) != ''" +
        notAdmins(p) +
        " GROUP BY run" +
        " ORDER BY last_day DESC LIMIT " + num(RUN_ROWS_MAX)
    })
  },

  /* --- The number that is actually true ------------------------------------
     The only query that never touches PostHog. `subscribe_funnel`'s last step
     is derived from a browser event and is therefore subject to ad blockers,
     closed tabs and the 10-25% loss any client-side analytics carries. This is
     read from Firestore with count() aggregations: a number, computed
     server-side, with no document fetched and no field read but the count. When
     the two disagree, this one wins.

     Cost is two aggregation queries, billed at one document read per 1,000
     index entries matched — so a thousand accounts is two reads. */
  subscription_totals: {
    params: ["exclude_admins"],
    firestore: true
  }
};

/* The order join.html moves through its panes. `jn-loading` and `jn-login` are
   interstitials rather than steps the reader chooses, which is why STEPS in
   that file is only two long and ALL is five; all five are reported here
   because "how far through" is a question about screens seen. */
const JOIN_STEPS = ["jn-you", "jn-loading", "jn-plan", "jn-login", "jn-done"];

/* ==========================================================================
   THE QUIZ FUNNEL'S SCREEN LIST — A VERBATIM COPY OF FBOB.SCREENS

   js/onboard.js declares SCREENS and exports it as FBOB.SCREENS. This is the
   same list, in the same order, with the same `kind` and the same declared
   position, plus the label this API prints. tools/check-analytics.js compares
   the id/kind/n triples in both files and fails the build when they drift.

   WHY A COPY AND NOT AN INFERENCE. Two reasons, and the second is the one
   that costs money:

     1. Order. The same rule JOIN_STEPS already follows — an order inferred
        from counts is right until the day a step gains traffic from
        somewhere else, and then it is silently wrong.

     2. Absence. A screen nobody reached returns NO ROW from PostHog, which
        looks identical to a screen that was never instrumented. Those are
        completely different findings — "nobody got that far" and "we are not
        measuring that" — and the only way to tell them apart is to know the
        list of screens that ought to exist. shapeOnboardingSteps() zero-fills
        from this list and marks the fills `never_fired`, and the panel draws
        them as an em-dash rather than a 0, because a zero implies a
        measurement was taken.

   `n` IS THE DECLARED POSITION, not the count of screens a reader saw, so
   two readers who branch differently still compare. THIRTEEN, not the twelve
   ONBOARDING-ANALYTICS.md was written against: the engine inserted q_genres
   at position 6 and everything from there down moved by one. If this list
   still said twelve, every row from q_time onward would be labelled with the
   name of the screen above it.

   The label is what a human reads; it is short because it has to fit a
   chart's label column, and the full screen id is in the table beside it. */
const OB_STEPS = [
  ["welcome",       "intro",    1,  "Welcome"],
  ["q_draw",        "question", 2,  "Q1 · What draws you in"],
  ["affirm_draw",   "affirm",   3,  "After Q1"],
  ["q_relate",      "question", 4,  "Q2 · What you relate to"],
  ["affirm_relate", "affirm",   5,  "After Q2"],
  ["q_genres",      "question", 6,  "Q3 · Which histories"],
  ["q_time",        "question", 7,  "Q4 · How long"],
  ["q_streak",      "question", 8,  "Q5 · Streak"],
  ["pick_story",    "pick",     9,  "Pick a story"],
  ["building",      "loader",   10, "Building your feed"],
  ["results",       "results",  11, "Results"],
  ["account",       "account",  12, "Account screen"],
  ["paywall",       "paywall",  13, "Paywall screen"]
];

/* The end-to-end ladder, in the order it happens, from the first screen of
   the questions to somebody coming back a day later. Each rung is a key from
   onboarding_conversion's per-person row and a test on it; the test is a
   function so a rung that is "either of two surfaces" — reached the login
   screen, reached the paywall — can say so rather than being split into two
   rungs that both look like drop-off.

   Every label says what the number IS rather than what it would be nice for
   it to mean. "Sent to Stripe" and not "started paying": everything past
   that request happens on somebody else's origin and no browser event of
   ours can see it. */
const OB_FUNNEL_STEPS = [
  ["opened",          "Opened the questions",
   (r) => cnt(r.opened) > 0],
  ["q1_shown",        "Saw the first question",
   (r) => cnt(r.q1_shown) > 0],
  ["q1_answered",     "Answered: what draws you in",
   (r) => cnt(r.q1_answered) > 0],
  ["q2_answered",     "Answered: what you relate to",
   (r) => cnt(r.q2_answered) > 0],
  ["q3_answered",     "Answered: which histories",
   (r) => cnt(r.q3_answered) > 0],
  ["q4_answered",     "Answered: how long",
   (r) => cnt(r.q4_answered) > 0],
  ["q5_answered",     "Answered: streak",
   (r) => cnt(r.q5_answered) > 0],
  ["pick_shown",      "Saw the story pick",
   (r) => cnt(r.pick_shown) > 0],
  ["picked",          "Picked a story",
   (r) => cnt(r.picked) > 0],
  ["loader",          "Reached the loader",
   (r) => cnt(r.loader) > 0],
  ["results",         "Saw the results",
   (r) => cnt(r.results) > 0],
  ["finished",        "Finished the questions",
   (r) => cnt(r.finished) > 0],
  /* Either surface counts. The split is returned below as context. */
  ["reached_login",   "Reached a way to sign in",
   (r) => cnt(r.account_screen) > 0 || cnt(r.join_gate) > 0],
  ["signed_any",      "Signed in or made an account",
   (r) => cnt(r.signed_any) > 0],
  ["reached_paywall", "Reached the paywall",
   (r) => cnt(r.paywall_screen) > 0 || cnt(r.paywall_hit) > 0 || cnt(r.join_gate) > 0],
  ["plan_picked",     "Picked a plan",
   (r) => cnt(r.plan_picked) > 0],
  ["stripe",          "Sent to Stripe",
   (r) => cnt(r.stripe) > 0],
  ["came_back",       "Came back with access",
   (r) => cnt(r.came_back) > 0],
  ["subscribed",      "Came back from Stripe with access",
   (r) => cnt(r.subscribed) > 0],
  /* A DEFINITION rather than an event, and identical to firststory_funnel's
     on purpose so the two panels agree: more than one calendar day in UTC
     with any event on it, inside this window. */
  ["returned_later",  "Came back on a later day",
   (r) => cnt(r.days_active) > 1]
];

/* Not rungs. `pct_of_previous: null` is how a row says "do not draw me in the
   funnel" — the signal subscribe_funnel's `blocked` row already carries and
   js/dashboard.js already reads generically, so adding one here needs no
   change there.

   `account_created` is here rather than in the ladder because it is
   undercounted by every account made with Google: login.html fires
   signin_google for a new account and a returning one alike. Until
   getAdditionalUserInfo(cred).isNewUser lands in js/auth.js, `signed_any` is
   the trustworthy line and this is context. */
const OB_CONTEXT_STEPS = [
  ["account_created", "Made an account (undercounted — see the note)",
   (r) => cnt(r.account_created) > 0],
  ["login_via_quiz",  "Reached the quiz's own account screen",
   (r) => cnt(r.account_screen) > 0],
  ["login_via_join",  "Reached /join instead",
   (r) => cnt(r.join_gate) > 0],
  ["blocked",         "Blocked before Stripe",
   (r) => cnt(r.blocked) > 0]
];

/* One place that turns whatever PostHog put in a cell into a number. Every
   test above runs through it, so a column that arrives as the string "3"
   because the property was a string on some events is still three. */
function cnt(v) {
  const x = Number(v || 0);
  return isFinite(x) ? x : 0;
}

/* Human labels for the funnel, in step order. Kept beside the query rather
   than in the dashboard so the two cannot drift. */
const FUNNEL_STEPS = [
  ["locked_story",    "Reached a locked story"],
  ["gate_opened",     "Opened the gate"],
  ["signed_in",       "Signed in"],
  ["account_created", "Created an account"],
  ["reached_stripe",  "Reached Stripe"],
  ["came_back",       "Came back with access"],
  ["subscribed",      "Subscribed"]
];

/* ==========================================================================
   PARSING WHAT WAS ASKED
   ========================================================================== */

/* --- Names the dashboard already uses -----------------------------------
   `js/dashboard.js` was written in parallel with this file and against seven
   shorter names. Both halves are right and neither is worth a rename round
   trip, so both are accepted: the alias resolves to the canonical query, the
   response reports the canonical name, and `meta.requested` says which name
   came in. ANALYTICS-API.md lists these as accepted and the long ones as
   preferred, because a name like `errors` will not age well next to a second
   kind of error.

   `events` maps to `button_presses`: that panel searches by name and renders a
   `control` column, which is what ui_click carries. */
const ALIASES = {
  stories: "story_performance",
  story_cards: "card_dropoff",
  funnel: "subscribe_funnel",
  onboarding: "onboarding_funnel",
  events: "button_presses",
  audio: "audio_usage",
  errors: "client_errors"
};

/* A real calendar date, and one that means what it says: `2026-02-31` matches
   the expression and is not a date, so it is round-tripped through Date and
   refused if the answer differs. */
function dateParam(v, field) {
  const s = strParam(v, RE_DATE, field, true);
  if (!s) return "";
  const d = new Date(s + "T00:00:00Z");
  if (!isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(field);
  return s;
}

const DAY_MS = 86400000;

/**
 * The window, from whichever pair of parameters the caller sent.
 *
 * A dashboard with a date picker has two dates; a curl has a number of days.
 * Both arrive here and leave as either { from, to } or { days }, never both,
 * so `since()` has one thing to look at.
 *
 * The span is clamped the same way `days` is, by moving `from` FORWARD rather
 * than refusing: a picker dragged across a year is a picker at its end, not an
 * attack, and DAYS_MAX is a cost bound however the range was expressed. What
 * was actually used comes back in meta, so nothing has to guess.
 */
function readWindow(raw, p, echo, cap) {
  const from = dateParam(raw.from, "from");
  const to = dateParam(raw.to, "to");

  if (!from && !to) {
    /* THE PER-QUERY CEILING APPLIES HERE TOO, and for a while it did not.
       `cap` was read at the top of readParams and then only ever consulted
       on the from/to path below, so `event_volume` — whose whole reason for
       having a ceiling is that a 36-day day-by-day scan timed out upstream
       with a 502 — answered `{"days": 90}` by running the 90-day scan. The
       comment beside that query said the range "is clamped here rather than
       left to fail" and it was true of the path a date picker uses and
       false of the path every curl and every default uses.

       Found by asking person_timeline for 90 days and getting 90 days. The
       clamp is the same one: move the number down, echo
       `clamped_to_days`, and let the caller see the window they actually
       got rather than the one they asked for. */
    let d = intParam(raw.days, DAYS_MIN, DAYS_MAX, DAYS_DEFAULT, "days");
    if (cap && d > cap) {
      d = cap;
      echo.clamped_to_days = cap;
    }
    p.days = d;
    echo.days = d;
    return;
  }

  /* One end given is a half-open range, and the open end is today. Refusing
     would be pedantry; a dashboard that has only just had its start date
     picked is mid-interaction, not broken. */
  const todayIso = new Date().toISOString().slice(0, 10);
  let a = from || todayIso;
  let b = to || todayIso;
  if (a > b) { const t = a; a = b; b = t; }

  const span = Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS) + 1;
  if (span > DAYS_MAX) {
    a = new Date(Date.parse(b + "T00:00:00Z") - (DAYS_MAX - 1) * DAY_MS).toISOString().slice(0, 10);
  }

  /* A per-query ceiling, applied by moving the START forward rather than by
     refusing. The caller asked for a range; giving them the most recent part
     of it with `meta.clamped_to_days` set is more useful than a 502, and the
     dashboard prints the shortened range it actually got. */
  let kept = span;                       /* not `span`: it is a const above */
  if (cap && kept > cap) {
    a = new Date(Date.parse(b + "T00:00:00Z") - (cap - 1) * DAY_MS)
          .toISOString().slice(0, 10);
    echo.clamped_to_days = cap;
    kept = cap;
  }

  p.from = a;
  p.to = b;
  p.days = Math.min(DAYS_MAX, Math.max(DAYS_MIN, kept));
  echo.from = a;
  echo.to = b;
  echo.days = p.days;
}

function readParams(name, raw) {
  const want = QUERIES[name].params || [];
  const cap = QUERIES[name].maxDays || 0;   /* per-query ceiling, 0 = none */
  const p = {};
  const echo = {};

  for (const key of want) {
    switch (key) {
      case "days":
        readWindow(raw, p, echo, cap);
        break;
      case "limit": {
        /* Three queries count something other than rows-a-human-reads and
           each carries its own cap. reader_activity counts (person, id,
           story) triples; reader_dwell counts (person, page, story, card)
           quads, which a twenty-card story multiplies again; person_timeline
           counts one reader's raw events. Everything else keeps the
           published 1–200. */
        const hi = name === "reader_activity" ? READER_ROWS_MAX
                 : name === "reader_dwell" ? DWELL_ROWS_MAX
                 : name === "person_timeline" ? TIMELINE_ROWS_MAX
                 : LIMIT_MAX;
        const dflt = name === "reader_activity" ? READER_ROWS_DEFAULT
                   : name === "reader_dwell" ? DWELL_ROWS_DEFAULT
                   : name === "person_timeline" ? TIMELINE_ROWS_DEFAULT
                   : LIMIT_DEFAULT;
        p.limit = intParam(raw.limit, LIMIT_MIN, hi, dflt, "limit");
        echo.limit = p.limit;
        break;
      }
      case "reader": {
        /* AN ORDINAL, NOT AN IDENTIFIER. What reader_activity printed in its
           `reader` column: 1 for the most recently active reader, 2 for the
           next. It is an integer and it is bounded by the roster's own cap,
           so there is nothing here to quote into a query — the person id it
           resolves to is read from PostHog's answer to the roster query, not
           from anything the caller sent.

           It arrives as a string from a dashboard and as a number from curl,
           and intParam takes either. Rejected rather than clamped: `reader:
           0` and `reader: 900` are not sliders at their ends, they are a
           dashboard that has lost track of which row was clicked, and
           silently answering about reader 1 instead would put one person's
           afternoon under another person's name. */
        const v = raw.reader;
        if (v === undefined || v === null || v === "") throw bad("reader");
        /* A NUMBER OR A STRING, and nothing else. Without this line JSON's
           `[1]` arrives, String() turns it into "1", Number() turns that
           into 1, and a malformed body quietly resolves to reader 1 —
           somebody's timeline under a request that did not name them. It
           was caught by sending exactly that. `[1,2]` was already refused,
           which is the worst kind of nearly-safe: right by accident. */
        if (typeof v !== "number" && typeof v !== "string") throw bad("reader");
        const n = typeof v === "number" ? v : Number(v);
        if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > READER_ROWS_MAX) {
          throw bad("reader");
        }
        p.reader = n;
        echo.reader = n;
        break;
      }
      case "roster_limit":
        /* The `limit` the caller passed to reader_activity when it drew the
           table the ordinal came from. Ordinals are stable under truncation
           for every reader before the cut, so this matters only when the
           roster was actually truncated — but when it was, resolving against
           a different roster size can resolve to a different person, and
           "usually right" is not a property this query may have. */
        p.rosterLimit = intParam(raw.roster_limit, LIMIT_MIN, READER_ROWS_MAX,
                                 READER_ROWS_DEFAULT, "roster_limit");
        echo.roster_limit = p.rosterLimit;
        break;
      case "exclude_admins":
        /* DEFAULT ON. The honest default is "numbers about strangers":
           three accounts exist on this project and all three are founders',
           so unfiltered every figure on the dashboard is mostly their own
           testing. Seeing your own traffic is the special case and has to be
           asked for. */
        p.excludeAdmins = boolParam(raw.exclude_admins, true, "exclude_admins");
        echo.exclude_admins = p.excludeAdmins;
        break;
      case "story":
        p.story = strParam(raw.story, RE_STORY, "story", true);
        if (p.story) echo.story = p.story;
        break;
      case "page":
        p.page = strParam(raw.page, RE_PAGE, "page", true);
        if (p.page) echo.page = p.page;
        break;
      case "contains":
        /* `q` is what js/dashboard.js's search box sends. Same rule, same
           character set, same refusal. */
        p.contains = strParam(
          raw.contains !== undefined && raw.contains !== "" ? raw.contains : raw.q,
          RE_CONTAINS, "contains", true
        );
        if (p.contains) echo.contains = p.contains;
        break;
      case "release":
        p.release = strParam(raw.release, RE_RELEASE, "release", true);
        if (p.release) echo.release = p.release;
        break;
      case "event": {
        const ev = strParam(raw.event, /^[a-z0-9_]{1,40}$/, "event", false);
        if (KNOWN_EVENTS.indexOf(ev) === -1) throw bad("event");
        p.event = ev;
        echo.event = ev;
        break;
      }
      default:
        break;
    }
  }
  return { p, echo };
}

/* ==========================================================================
   THE ADMIN CHECK

   Three refusals, one answer. A signed-out caller, a non-admin and a forged
   token all get `403 {"ok":false,"error":"not_admin"}` with no other key and
   no other status code, because telling the three apart tells a stranger
   whether a token was valid, whether an account exists, and whether it is the
   admin one. The log line knows the difference; the response does not.
   ========================================================================== */

async function requireAdmin(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { ok: false, why: "no_token" };

  let decoded;
  try {
    /* checkRevoked. It costs an occasional lookup against Firebase Auth and it
       is the difference between "this token was valid when issued" and "this
       account is still allowed". An admin account whose access is withdrawn
       has up to an hour of valid token in the wild otherwise, and an hour of
       every reader's behaviour is worth more than one extra request. */
    decoded = await admin.auth().verifyIdToken(m[1], true);
  } catch (err) {
    /* Expired, revoked, forged, or from another Firebase project. Signature
       verification happens locally against cached public keys, so a forged
       token costs no network call and no database read — which is why the
       rate limits below can safely sit after this check. */
    return { ok: false, why: "bad_token" };
  }

  const uid = decoded && decoded.uid ? String(decoded.uid) : "";
  if (!uid) return { ok: false, why: "bad_token" };

  /* THE READ THAT DECIDES. Not the token, not a custom claim, and above all
     not the client: js/auth.js keeps the same flag for painting a link, and a
     variable in a browser is not an authorisation. Exactly the test auth.js
     applies, against the same document, which firestore.rules lets no client
     write. */
  let snap;
  try {
    snap = await db.doc("customers/" + uid).get();
  } catch (err) {
    logger.error("insights admin read failed", { message: err && err.message });
    return { ok: false, why: "read_failed" };
  }

  const d = snap.exists ? (snap.data() || {}) : {};
  const isAdmin = d.admin === true || d.role === "admin";
  if (!isAdmin) return { ok: false, why: "not_admin", uid: uid };

  return { ok: true, uid: uid };
}


/* ==========================================================================
   WHO THE ADMINS ARE

   The exclusion is built here, out of Firestore, and never out of anything a
   caller sent. `customers` is the same collection requireAdmin() has just
   read one document of, with the same test js/auth.js applies — `admin ===
   true` or `role === "admin"` — so an account that can open the dashboard is
   an account that disappears from it.

   Cached for a minute, module-scope. That is per instance and therefore not a
   security boundary, which is fine because it is not doing security: it is
   saving seventeen collection scans per render. maxInstances is 3, so the
   worst case is three copies of a three-element array.
   ========================================================================== */

let adminCache = { at: 0, uids: [] };

/* The caller is an admin — requireAdmin just proved it against the same
   document. Adding their uid means the filter is never empty and never misses
   the one person we are certain about, whatever field granted it. */
function withCaller(uids, callerUid) {
  if (!callerUid || !RE_UID.test(callerUid)) return uids.slice(0);
  if (uids.indexOf(callerUid) !== -1) return uids.slice(0);
  return uids.concat([callerUid]);
}

async function adminUids(callerUid) {
  const now = Date.now();
  if (adminCache.at && now - adminCache.at < ADMIN_CACHE_MS) {
    return withCaller(adminCache.uids, callerUid);
  }

  const col = db.collection("customers");
  /* .select() with no field names asks for the document IDS and no fields at
     all — the id is what the filter is built from and nothing else here is
     wanted. Two queries because auth.js accepts either flag; a document
     carrying both is de-duplicated below rather than quoted twice. */
  const [byFlag, byRole] = await Promise.all([
    col.where("admin", "==", true).select().get(),
    col.where("role", "==", "admin").select().get()
  ]);

  const seen = Object.create(null);
  const out = [];
  for (const snap of [byFlag, byRole]) {
    for (const doc of snap.docs) {
      const id = String(doc.id || "");
      /* A document id is not user input — firestore.rules lets no client
         write here — but it is a value about to be quoted into a query, and
         the rule in this file is that such a value is checked at every step
         rather than trusted because of where it came from. An id that fails
         is skipped and logged, not silently dropped into lit() to throw and
         take the whole panel with it. */
      if (!RE_UID.test(id)) {
        logger.warn("insights: admin doc id is not quotable", { len: id.length });
        continue;
      }
      if (seen[id]) continue;
      seen[id] = 1;
      out.push(id);
    }
  }

  adminCache = { at: now, uids: out };
  return withCaller(out, callerUid);
}

/* ==========================================================================
   THE EMAIL JOIN — reader_activity, and nothing else

   PostHog gives a distinct_id. js/analytics.js calls identify(uid), so for a
   signed-in reader that string IS the Firebase uid. Firebase Auth turns it
   into an email. Both halves are held by this function and neither is held by
   the other service: THE EMAIL IS NEVER SENT TO POSTHOG AND MUST NOT BE.

   Anything that is not shaped like a Firebase uid is not asked about. A
   signed-out reader's distinct_id is PostHog's own identifier, and looking it
   up would be a wasted round trip with a "not found" at the end of it.
   ========================================================================== */

const RE_AUTH_UID = /^[A-Za-z0-9]{20,128}$/;

async function emailsFor(uids) {
  const want = [];
  const seen = Object.create(null);
  for (const u of uids) {
    const id = String(u || "");
    if (!RE_AUTH_UID.test(id) || seen[id]) continue;
    seen[id] = 1;
    want.push(id);
  }

  const map = Object.create(null);
  let asked = 0, failed = 0;
  for (let i = 0; i < want.length; i += AUTH_BATCH) {
    const batch = want.slice(i, i + AUTH_BATCH).map((uid) => ({ uid: uid }));
    asked += batch.length;
    try {
      const res = await admin.auth().getUsers(batch);
      for (const u of (res && res.users) || []) {
        if (u && u.uid && u.email) map[String(u.uid)] = String(u.email);
      }
    } catch (err) {
      /* One batch failing is a gap in a column, not a reason to throw away
         thirteen readers' behaviour. It is counted, and the endpoint refuses
         only when EVERY batch failed — see below. */
      failed += batch.length;
      logger.error("insights auth lookup failed", { message: err && err.message });
    }
  }
  return { map: map, asked: asked, failed: failed };
}

/* ==========================================================================
   RATE LIMITING

   The free first pass is per instance and per uid, in memory. It is not the
   throttle — support.js explains at length why a module-scope Map never was —
   but it costs nothing, needs no read, and turns a dashboard stuck in a render
   loop against one warm instance into zero database traffic.
   ========================================================================== */

const seen = new Map();

function throttledLocally(uid) {
  const now = Date.now();
  if (seen.size > 2000) seen.clear();      /* bounded: nothing here grows the heap */
  const rec = seen.get(uid) || { hits: [] };
  rec.hits = rec.hits.filter((t) => now - t < 60 * 1000);
  if (rec.hits.length >= PER_ADMIN_PER_MIN) {
    seen.set(uid, rec);
    return Math.max(1, Math.ceil((60 * 1000 - (now - rec.hits[0])) / 1000));
  }
  rec.hits.push(now);
  seen.set(uid, rec);
  return 0;
}

function today(d) { return (d || new Date()).toISOString().slice(0, 10); }
function thisHour(d) { return (d || new Date()).toISOString().slice(0, 13); }

/**
 * The authoritative counters. Two reads and two writes in one transaction, so
 * there is no window in which two containers both read "239 this hour" and
 * both write the 240th.
 *
 * `wantsUpstream` is false for subscription_totals, which never leaves Google
 * and therefore spends the per-admin budget but not the global PostHog one.
 *
 * The document id is the uid. Unlike support.js there is nothing to hash: the
 * caller is an authenticated admin whose uid is already a document id in
 * `customers`, so a counter keyed on it reveals nothing that document does
 * not, and there is no daily salt, no IP and no privacy cost at all. Counts
 * and timestamps only; `expiresAt` is written for a TTL policy whether or not
 * one is installed, so installing it later needs no code change.
 */
async function spendBudget(uid, when, upstreamCost) {
  const day = today(when);
  const hour = thisHour(when);
  const now = when.getTime();
  const rateRef = db.doc(RATE_COLLECTION + "/" + uid);
  const quotaRef = db.doc(QUOTA_DOC);

  await db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(rateRef, quotaRef);
    const rec = snaps[0].exists ? (snaps[0].data() || {}) : {};
    const q = snaps[1].exists ? (snaps[1].data() || {}) : {};

    function deny(code, retry) {
      const e = new Error(code);
      e.code = code;
      e.retry = retry;
      return e;
    }

    const perHour = rec.hour === hour ? Number(rec.hourCount || 0) : 0;
    if (perHour >= PER_ADMIN_PER_HOUR) {
      throw deny("rate_limited", 3600 - Math.floor((now % 3600000) / 1000));
    }
    const perDay = rec.day === day ? Number(rec.dayCount || 0) : 0;
    if (perDay >= PER_ADMIN_PER_DAY) throw deny("rate_limited", 0);

    /* The bound that actually caps a bad day. Everything above is per admin
       and there are two or three of those; this is the ceiling on how many
       times this project can ask PostHog anything at all in a day. */
    /* `upstreamCost` is a COUNT, not a switch: 0 for subscription_totals,
       which never leaves Google, 1 for a normal query, and 2 for
       person_timeline, which asks PostHog twice — once for the roster that
       turns an ordinal into a person and once for that person's events. A
       query that costs two and is billed one would let the global ceiling
       be overshot by half, quietly. */
    const upstreamToday = q.day === day ? Number(q.upstream || 0) : 0;
    if (upstreamCost > 0 && upstreamToday + upstreamCost > GLOBAL_PER_DAY) {
      throw deny("rate_limited", 0);
    }

    tx.set(rateRef, {
      uid: uid,
      hour: hour,
      hourCount: perHour + 1,
      day: day,
      dayCount: perDay + 1,
      last: now,
      expiresAt: admin.firestore.Timestamp.fromMillis(now + RATE_TTL_MS)
    });

    tx.set(quotaRef, {
      day: day,
      upstream: upstreamToday + upstreamCost,
      total: (q.day === day ? Number(q.total || 0) : 0) + 1
    }, { merge: true });
  });
}

/* ==========================================================================
   ASKING POSTHOG

   One POST, one HogQL query this file wrote, a hard timeout inside the
   function's own timeout, and a size ceiling on what comes back. Nothing from
   the request reaches the URL, the headers or the body except through a query
   text built above.
   ========================================================================== */

async function ask(sql, key, projectId) {
  const url = PH_HOST + "/api/projects/" + encodeURIComponent(projectId) + "/query/";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } })
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error("upstream");
    e.code = "upstream";
    /* An abort is a timeout, and a timeout is a query that wanted more than a
       dashboard should. Named separately so a log line says which. */
    e.reason = (err && err.name === "AbortError") ? "timeout" : "unreachable";
    throw e;
  }
  clearTimeout(timer);

  const text = await res.text();
  if (text.length > MAX_UPSTREAM_BYTES) {
    const e = new Error("upstream");
    e.code = "upstream";
    e.reason = "too_large";
    throw e;
  }

  if (!res.ok) {
    const e = new Error("upstream");
    e.code = "upstream";
    e.reason = res.status === 401 || res.status === 403 ? "denied"
             : res.status === 429 ? "posthog_rate_limited"
             : "status_" + res.status;
    /* The upstream body may quote the query and, on an auth failure, say
       something about the key. It goes to the log, truncated, and never to
       the caller. */
    e.detail = text.slice(0, 300);
    throw e;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    const e = new Error("upstream");
    e.code = "upstream";
    e.reason = "unparseable";
    throw e;
  }
  return body;
}

/* PostHog answers with `results` as arrays and `columns` as names. The column
   list this file declared wins: relying on the upstream echo means a rename
   there silently renames a field the dashboard reads. Positional, which is
   what SELECT order guarantees. */
function toRows(body, columns) {
  const out = [];
  const results = (body && Array.isArray(body.results)) ? body.results : [];
  for (const r of results) {
    const row = {};
    if (Array.isArray(r)) {
      for (let i = 0; i < columns.length; i++) row[columns[i]] = clean(r[i]);
    } else if (r && typeof r === "object") {
      for (const c of columns) row[c] = clean(r[c]);
    } else {
      continue;
    }
    out.push(row);
  }
  return out;
}

/* A value the dashboard can render without checking its type. Strings,
   finite numbers, or null — never undefined, never an object, never NaN. */
function clean(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function pct(a, b) {
  if (!b) return 0;
  return Math.round((1000 * a) / b) / 10;
}

/* ==========================================================================
   SHAPING

   Everything a chart wants that SQL would make harder to read than to
   compute: the two derived percentages on card_dropoff, the pivot of the two
   single-row aggregates, and the fixed step order on the onboarding funnel.
   ========================================================================== */

function shape(name, rows) {
  if (name === "card_dropoff") {
    /* Rows arrive ordered by story then card. reach_pct is against card 1 of
       the same story; dropoff_pct is against the previous card of the same
       story. A story whose first row is not card 1 — possible if a limit cut
       it, or if a reader's first measured card was the second — gets its
       first present card as the baseline, and says so by reporting 100. */
    const base = {};
    let prevStory = "", prevReaders = 0;
    for (const r of rows) {
      const readers = Number(r.readers || 0);
      if (base[r.story] === undefined) base[r.story] = readers;
      r.reach_pct = pct(readers, base[r.story]);
      r.dropoff_pct = (r.story === prevStory && prevReaders)
        ? Math.max(0, Math.round((1000 * (prevReaders - readers)) / prevReaders) / 10)
        : 0;
      prevStory = r.story;
      prevReaders = readers;
    }
    return rows;
  }

  if (name === "firststory_cards") {
    /* The same two derived numbers card_dropoff carries, against PEOPLE
       rather than views: a graph of "how many made it to each card" is a
       graph of people, and views double-count a reader who scrolled back. */
    let base = null, prev = 0;
    for (const r of rows) {
      const people = Number(r.people || 0);
      if (base === null) base = people;
      r.reach_pct = pct(people, base);
      r.dropoff_pct = prev
        ? Math.max(0, Math.round((1000 * (prev - people)) / prev) / 10)
        : 0;
      prev = people;
    }
    return rows;
  }

  if (name === "story_stop_points") {
    const total = {};
    for (const r of rows) total[r.story] = (total[r.story] || 0) + Number(r.sessions || 0);
    for (const r of rows) r.share_pct = pct(Number(r.sessions || 0), total[r.story]);
    return rows;
  }

  if (name === "subscribe_funnel") {
    const one = rows[0] || {};
    const out = [];
    let first = 0, prev = 0;
    for (const [key, label] of FUNNEL_STEPS) {
      const people = Number(one[key] || 0);
      if (!out.length) first = people;
      out.push({
        step: key,
        label: label,
        people: people,
        pct_of_first: pct(people, first),
        pct_of_previous: out.length ? pct(people, prev) : 100
      });
      prev = people;
    }
    /* Not a step. A leak, and `checkout_blocks` says which one. */
    out.push({
      step: "blocked",
      label: "Blocked before Stripe",
      people: Number(one.blocked || 0),
      pct_of_first: pct(Number(one.blocked || 0), first),
      pct_of_previous: null
    });
    return out;
  }

  if (name === "audio_usage") {
    const one = rows[0] || {};
    const users   = Number(one.sound_users || 0);
    const readers = Number(one.readers || 0);
    const plays   = Number(one.plays || 0);
    const mutes   = Number(one.mutes || 0);
    const legacy  = Number(one.undirected_legacy_taps || 0);
    const out = [
      { metric: "plays", label: "Turned sound ON",  value: plays },
      { metric: "mutes", label: "Muted the sound",  value: mutes }
    ];
    /* Only shown when there are any. A permanent zero row headed "direction
       not recorded" invites the question every time the page is opened, long
       after the answer stopped being interesting. */
    if (legacy) {
      out.push({ metric: "undirected_legacy_taps",
                 label: "Presses before the split (direction not recorded)",
                 value: legacy });
    }
    out.push(
      { metric: "sound_users", label: "People who touched the sound",  value: users },
      { metric: "readers",     label: "People who opened a story",     value: readers },
      { metric: "share_pct",   label: "Share who touched the sound",   value: pct(users, readers) }
    );
    return out;
  }

  if (name === "onboarding_funnel") {
    /* Known steps in the order join.html moves through them, anything else
       after, by people. Order from the source file, never inferred from the
       counts: an inferred order is right until a step gains traffic from
       somewhere else, and then it is quietly wrong. */
    const rank = (s) => {
      const i = JOIN_STEPS.indexOf(String(s));
      return i === -1 ? JOIN_STEPS.length : i;
    };
    rows.sort((a, b) => {
      const d = rank(a.step) - rank(b.step);
      if (d) return d;
      return Number(b.people || 0) - Number(a.people || 0);
    });
    const first = rows.length ? Number(rows[0].people || 0) : 0;
    for (const r of rows) {
      r.reach_pct = pct(Number(r.people || 0), first);
      r.finished = r.step === "jn-done";
    }
    return rows;
  }

  return rows;
}


/* ==========================================================================
   THE QUIZ FUNNEL — four folds

   Called by the endpoint instead of shape(), like shapeGeo and
   shapeFirstStory, because each returns its own `meta`: a caveat about an
   answer has to travel with the answer rather than be remembered by whoever
   reads it.

   THE ONE RULE THAT RUNS THROUGH ALL FOUR. This product has almost no
   readers. `meta.pct_usable` is false when the funnel's first declared step
   has fewer than PCT_MIN_PEOPLE people, and when it is false the page prints
   counts and no percentages anywhere in the panel. The threshold is decided
   HERE and obeyed there, which is the geo_usable precedent: the function
   says whether a number is real, and the page does not get a second opinion.
   `meta.first_people` comes back with it so the page can name the
   denominator in its sentence without recomputing it from the rows.
   ========================================================================== */

/* A step that is DECLARED and returned no row is not the same as a step that
   returned a zero, and this is the whole reason OB_STEPS is declared. It is
   marked `never_fired` and the page draws an em-dash. */
function shapeOnboardingSteps(rows) {
  /* Fold by step id. GROUP BY step, kind can in principle return two rows
     for one screen — if `kind` were ever missing on one of the two events
     that carry it — and two rows for one rung would double a denominator.
     Counts add; the median comes from whichever row had the most views,
     because medians cannot be added and averaging two of them would invent
     a number. */
  const by = Object.create(null);
  for (const r of rows) {
    const id = String(r.step || "");
    if (!id) continue;
    const seen = by[id];
    if (!seen) {
      by[id] = {
        views: cnt(r.views), runs: cnt(r.runs), people: cnt(r.people),
        forwards: cnt(r.forwards), backs: cnt(r.backs), skips: cnt(r.skips),
        exits: cnt(r.exits), dwell_s: cnt(r.dwell_s),
        dwell_s_capped: cnt(r.dwell_s_capped),
        median_dwell_s: r.median_dwell_s === null || r.median_dwell_s === undefined
          ? null : cnt(r.median_dwell_s),
        top: cnt(r.views)
      };
      continue;
    }
    seen.views += cnt(r.views);
    seen.runs += cnt(r.runs);
    seen.people += cnt(r.people);
    seen.forwards += cnt(r.forwards);
    seen.backs += cnt(r.backs);
    seen.skips += cnt(r.skips);
    seen.exits += cnt(r.exits);
    seen.dwell_s += cnt(r.dwell_s);
    seen.dwell_s_capped += cnt(r.dwell_s_capped);
    if (cnt(r.views) > seen.top) {
      seen.top = cnt(r.views);
      seen.median_dwell_s = r.median_dwell_s === null || r.median_dwell_s === undefined
        ? null : cnt(r.median_dwell_s);
    }
  }

  const out = [];
  let first = 0, prev = 0, everFired = 0, lastFiredOrder = 0;

  for (let i = 0; i < OB_STEPS.length; i++) {
    const id = OB_STEPS[i][0], kind = OB_STEPS[i][1];
    const order = OB_STEPS[i][2], label = OB_STEPS[i][3];
    const g = by[id] || null;
    const people = g ? g.people : 0;
    if (i === 0) first = people;
    if (g) { everFired++; lastFiredOrder = order; }

    out.push({
      step: id,
      label: label,
      kind: kind,
      order: order,
      /* NEVER a zero for a step with no row. A zero is the result of a
         measurement and this is the absence of one. */
      never_fired: !g,
      views: g ? g.views : null,
      runs: g ? g.runs : null,
      people: g ? g.people : null,
      forwards: g ? g.forwards : null,
      backs: g ? g.backs : null,
      skips: g ? g.skips : null,
      exits: g ? g.exits : null,
      /* THE SIZE OF THE BLIND SPOT, PRINTED RATHER THAN ABSORBED.
         ONBOARDING-ANALYTICS.md section 2: the in-app browsers this audience
         arrives through frequently tear the webview down without firing
         pagehide at all, so some screen views end with no ob_leave of any
         kind. Folding those into `exits` would report "we stopped seeing
         them here" as "they left", which is a different claim. Floored at
         zero because a screen still open when the window closed leaves
         without its ob_leave. */
      unaccounted: g
        ? Math.max(0, g.views - (g.forwards + g.backs + g.skips + g.exits))
        : null,
      dwell_s: g ? round1(g.dwell_s) : null,
      dwell_s_capped: g ? round1(g.dwell_s_capped) : null,
      median_dwell_s: g ? g.median_dwell_s : null,
      /* Against the FIRST DECLARED step and the PREVIOUS DECLARED step, not
         against whatever happened to come back — which is what makes a gap
         in the middle of the flow visible as a gap. */
      reach_pct: g ? pct(people, first) : null,
      dropoff_pct: g && prev ? Math.max(0, pct(prev - people, prev)) : null
    });
    if (g) prev = people;
  }

  /* THE MOST USEFUL SENTENCE THIS PANEL CAN PRINT AT THIS TRAFFIC, and it
     costs one comparison: a declared step with no rows that has a LATER
     declared step WITH rows did not lose anybody — it is almost certainly
     not instrumented, because people cannot be past it without going
     through it. */
  const gaps = [];
  for (const r of out) {
    if (r.never_fired && r.order < lastFiredOrder) gaps.push(r.step);
  }

  return {
    rows: out,
    meta: {
      first_people: first,
      pct_usable: first >= PCT_MIN_PEOPLE,
      pct_min_people: PCT_MIN_PEOPLE,
      declared_steps: OB_STEPS.length,
      steps_fired: everFired,
      /* Steps with no row that have traffic BELOW them. An instrumentation
         gap, not a drop-off, and the page says which. */
      steps_missing_midflow: gaps
    }
  };
}

/* The end-to-end ladder, and the comparison the owner asked the question
   for. One row per person in, two things out: a ladder over the people who
   saw the quiz, and quiz-against-no-quiz at the rungs where money is.

   THE COHORTS. `quiz` is anybody with an ob_ event in this window; `noquiz`
   is anybody who reached the paywall or /join in this window with none. They
   are disjoint by construction and neither is a random assignment — readers
   are not split by a coin toss, they arrive by different routes on different
   days — so this is a DESCRIPTION of two groups and not an experiment. At
   this traffic it is a description of a handful of people. The panel says
   so, in those words, and does not offer it as a reason to turn the quiz
   off. */
function shapeOnboarding(rows) {
  const truncated = rows.length >= OB_PERSON_ROWS;

  const quiz = [], noquiz = [];
  for (const r of rows) {
    if (cnt(r.ob_events) > 0) { quiz.push(r); continue; }
    /* Somebody who only appears here because they signed in has not
       "reached the paywall without the quiz" — they have not reached it at
       all. The comparison group is the people who got to the same place by
       the other road. */
    if (cnt(r.paywall_hit) > 0 || cnt(r.join_gate) > 0) noquiz.push(r);
  }

  function count(cohort, test) {
    let k = 0;
    for (const r of cohort) if (test(r)) k++;
    return k;
  }

  const out = [];
  let first = 0, prev = 0;
  for (const spec of OB_FUNNEL_STEPS) {
    const people = count(quiz, spec[2]);
    if (!out.length) first = people;
    out.push({
      step: spec[0],
      label: spec[1],
      people: people,
      pct_of_first: pct(people, first),
      pct_of_previous: out.length ? pct(people, prev) : 100
    });
    prev = people;
  }
  for (const spec of OB_CONTEXT_STEPS) {
    const people = count(quiz, spec[2]);
    out.push({
      step: spec[0], label: spec[1], people: people,
      pct_of_first: pct(people, first),
      pct_of_previous: null
    });
  }

  /* THE COMPARISON, as a handful of rungs and nothing more. Not a whole
     second ladder: the no-quiz cohort has no quiz screens to have a ladder
     over, and drawing them side by side would put twelve empty rows beside
     twelve full ones and read as catastrophic drop-off. The same tests, both
     cohorts, at the places the two roads meet. */
  function side(cohort) {
    return {
      people: cohort.length,
      reached_paywall: count(cohort, (r) =>
        cnt(r.paywall_screen) > 0 || cnt(r.paywall_hit) > 0 || cnt(r.join_gate) > 0),
      signed_any: count(cohort, (r) => cnt(r.signed_any) > 0),
      stripe: count(cohort, (r) => cnt(r.stripe) > 0),
      subscribed: count(cohort, (r) => cnt(r.subscribed) > 0),
      returned_later: count(cohort, (r) => cnt(r.days_active) > 1)
    };
  }

  return {
    rows: out,
    meta: {
      first_people: first,
      pct_usable: first >= PCT_MIN_PEOPLE,
      pct_min_people: PCT_MIN_PEOPLE,
      cohort: quiz.length,
      truncated: truncated,
      /* Both sides of "how do the both perform". A fixed shape, six numbers
         each — this is meta because it is an aside about the answer, not a
         second answer. */
      compare: { quiz: side(quiz), noquiz: side(noquiz) }
    }
  };
}

/* Which answers, joined to what those people went on to do. The person id is
   the join key and it does not survive this function; check that again after
   editing. */
function shapeOnboardingAnswers(triples, outcomes, limit) {
  const truncated = triples.length >= ANSWER_ROWS_MAX ||
                    outcomes.length >= OUTCOME_ROWS_MAX;

  const by = Object.create(null);
  for (const o of outcomes) {
    const k = String(o.person || "");
    if (k) by[k] = o;
  }

  /* PEOPLE, not events. A reader who went back and changed an answer fired
     ob_answer twice for one opinion, and counting the taps would make an
     answer people hesitate over look popular. */
  const groups = Object.create(null);
  const order = [];
  let unjoined = 0;

  for (const t of triples) {
    const q = String(t.q || "");
    const a = String(t.answer === null || t.answer === undefined ? "" : t.answer);
    const person = String(t.person || "");
    if (!q || !person) continue;
    const key = q + " " + a;
    let g = groups[key];
    if (!g) {
      g = groups[key] = { q: q, answer: a, people: 0, runs: 0, answers: 0,
                          finished: 0, accounts: 0, stripe: 0, subscribed: 0 };
      order.push(g);
    }
    g.people++;
    g.runs += cnt(t.runs);
    g.answers += cnt(t.answers);
    const o = by[person];
    if (!o) { unjoined++; continue; }
    if (cnt(o.finished) > 0) g.finished++;
    if (cnt(o.account) > 0) g.accounts++;
    if (cnt(o.stripe) > 0) g.stripe++;
    if (cnt(o.subscribed) > 0) g.subscribed++;
  }

  for (const g of order) {
    g.finished_pct = pct(g.finished, g.people);
    g.subscribed_pct = pct(g.subscribed, g.people);
  }

  /* Question first, then the most-chosen answer, so the rows read as a
     questionnaire rather than as a leaderboard of unrelated keys. */
  order.sort((x, y) => {
    if (x.q !== y.q) return x.q < y.q ? -1 : 1;
    return y.people - x.people;
  });

  const cut = order.length > limit;
  return {
    rows: cut ? order.slice(0, limit) : order,
    meta: {
      truncated: truncated || cut,
      answer_rows: order.length,
      /* People whose answers came back but whose outcomes did not, because
         the outcome roster hit its own cap. Their answers are counted and
         their conversion is not, so every pct column is a floor for them —
         which is a thing to say rather than to average away. */
      outcomes_missing: unjoined
    }
  };
}

/* Runs: how they ended, and on which build they ran.

   THE BUCKETS ARE ABOUT RUNS AND THE PEOPLE COLUMN IS ABOUT PEOPLE, and they
   do not add up to each other on purpose: one person with three abandoned
   runs is three runs and one person. */
function shapeOnboardingRuns(rows) {
  const truncated = rows.length >= RUN_ROWS_MAX;

  /* How many runs each person has in this window. It is what separates
     "gave up" from "gave up and came back for another go", and it cannot be
     known from one run's row. */
  const runsPer = Object.create(null);
  for (const r of rows) {
    const p = String(r.person || "");
    if (p) runsPer[p] = (runsPer[p] || 0) + 1;
  }

  const BUCKETS = [
    ["finished_first_run",      "Finished, first go"],
    ["finished_after_resume",   "Finished after picking it back up"],
    ["abandoned_once",          "Stopped, and did not come back"],
    ["abandoned_and_restarted", "Stopped, and started again"]
  ];

  const acc = Object.create(null);
  for (const b of BUCKETS) {
    acc[b[0]] = { bucket: b[0], label: b[1], runs: 0,
                  people: Object.create(null),
                  screens: [], furthest: [], total: [] };
  }

  const builds = Object.create(null);
  const buildOrder = [];

  for (const r of rows) {
    const person = String(r.person || "");
    const finished = cnt(r.finished) > 0;
    const resumed = cnt(r.resumed) > 0;
    const again = person ? (runsPer[person] || 1) > 1 : false;
    const key = finished
      ? (resumed ? "finished_after_resume" : "finished_first_run")
      : (again ? "abandoned_and_restarted" : "abandoned_once");

    const b = acc[key];
    b.runs++;
    if (person) b.people[person] = 1;
    if (r.screens !== null && r.screens !== undefined) b.screens.push(cnt(r.screens));
    if (r.furthest_n !== null && r.furthest_n !== undefined) b.furthest.push(cnt(r.furthest_n));
    if (r.total_s !== null && r.total_s !== undefined) b.total.push(cnt(r.total_s));

    /* THE BUILD SLICE, and it is the whole answer to "he may revert the
       motion". `release` is js/analytics.js's RELEASE constant, put on
       ob_step — an already-registered property name, so it costs none of
       the remaining GA4 registrations — and a deploy changes it. A run
       carries the build it started on. Runs whose ob_step predates the
       property are grouped under null and labelled, never silently merged
       into the newest build. */
    const rel = r.release === null || r.release === undefined ? "" : String(r.release);
    let g = builds[rel];
    if (!g) {
      g = builds[rel] = { release: rel || null, runs: 0, finished: 0,
                          people: Object.create(null),
                          first_day: String(r.first_day || ""),
                          last_day: String(r.last_day || "") };
      buildOrder.push(g);
    }
    g.runs++;
    if (finished) g.finished++;
    if (person) g.people[person] = 1;
    const fd = String(r.first_day || ""), ld = String(r.last_day || "");
    if (fd && (!g.first_day || fd < g.first_day)) g.first_day = fd;
    if (ld && ld > g.last_day) g.last_day = ld;
  }

  const out = [];
  let allRuns = 0;
  const allPeople = Object.create(null);
  for (const spec of BUCKETS) {
    const b = acc[spec[0]];
    allRuns += b.runs;
    let people = 0;
    for (const k in b.people) { people++; allPeople[k] = 1; }
    out.push({
      bucket: b.bucket,
      label: b.label,
      runs: b.runs,
      people: people,
      /* Medians, never means. One run left open in a background tab owns a
         mean of four runs and says nothing true about any of them. */
      median_screens: medianOf(b.screens),
      median_furthest_n: medianOf(b.furthest),
      median_total_s: medianOf(b.total)
    });
  }

  let peopleTotal = 0;
  for (const k in allPeople) peopleTotal++;

  /* Newest build first, and bounded: this is a slice of a window that is at
     most ninety days, and a site that deploys daily would otherwise put
     ninety rows in an aside. */
  buildOrder.sort((a, b) => {
    const x = String(a.last_day || ""), y = String(b.last_day || "");
    if (x !== y) return x < y ? 1 : -1;
    return b.runs - a.runs;
  });
  const builds_out = [];
  for (let i = 0; i < buildOrder.length && i < 12; i++) {
    const g = buildOrder[i];
    let people = 0;
    for (const k in g.people) people++;
    builds_out.push({
      release: g.release,
      runs: g.runs,
      people: people,
      finished: g.finished,
      finished_pct: pct(g.finished, g.runs),
      first_day: g.first_day || null,
      last_day: g.last_day || null
    });
  }

  return {
    rows: out,
    meta: {
      truncated: truncated,
      runs: allRuns,
      people: peopleTotal,
      builds: builds_out,
      builds_seen: buildOrder.length
    }
  };
}

/* ==========================================================================
   READERS — the fold, the join, and the ordinal

   Called by the endpoint instead of shape(), because it has to await Firebase
   Auth. Three things happen here and the order matters:

     1. THE FOLD. PostHog returned one row per (person, distinct id, story).
        A reader who read signed out and then signed in has two distinct ids
        and one person_id, so folding on the person is what stops them
        appearing twice. Event counts add; "how far" takes the maximum,
        because a card seen under two identities is one card seen.

     2. THE JOIN. The distinct ids that look like Firebase uids are asked of
        Firebase Auth, in batches, and the first email found for a person is
        that person's email. No email means no account, which is a fact about
        the reader and not a gap to be filled in.

     3. THE ORDINAL. `reader` is "1", "2", "3" — assigned HERE, most recent
        first, per response. It is not stable between two responses and it is
        not derived from anything, so it cannot be used to follow a person
        across two loads of the page. It exists so the dashboard can group a
        reader's stories under one heading without ever being told the uid.

   The uid and the person_id do not appear in what is returned. Check that
   again after editing this: it is the whole of the privacy design.
   ========================================================================== */

/* THE FOLD AND THE ORDER, EXTRACTED, because two queries now depend on
   producing exactly the same one. `reader_activity` prints the ordinals and
   `person_timeline` resolves one back to a person, and if these two ever
   ordered readers differently the dashboard would show one person's
   timeline under another person's email — a wrong answer that looks
   completely right. One function, called by both. The returned records
   carry the person id; it is the caller's job never to send it on, and
   shapeReaders() below drops it. */
function foldReaders(rows, limit) {
  /* The query asked for limit + 1, so an extra row means there were more. */
  const truncated = rows.length > limit;
  const use = truncated ? rows.slice(0, limit) : rows;

  const byPerson = Object.create(null);
  const order = [];
  const ids = [];

  for (const r of use) {
    const story = (r.story === null || r.story === undefined) ? "" : String(r.story);
    /* An event whose story property was missing. It is a row about nothing,
       and there is no honest label for it. */
    if (!story) continue;
    const key = String(r.person || r.reader || "");
    if (!key) continue;

    let rec = byPerson[key];
    if (!rec) {
      rec = byPerson[key] = {
        person: String(r.person || ""),
        ids: [], last: "", stories: Object.create(null), list: []
      };
      order.push(rec);
    }

    const id = String(r.reader || "");
    if (id && rec.ids.indexOf(id) === -1) { rec.ids.push(id); ids.push(id); }

    const seen = String(r.last_seen || "");
    if (seen > rec.last) rec.last = seen;

    let st = rec.stories[story];
    if (!st) {
      st = rec.stories[story] = {
        story: story, opens: 0, completions: 0, cards: 0, furthest: null, last: ""
      };
      rec.list.push(st);
    }
    st.opens += Number(r.opens || 0);
    st.completions += Number(r.completions || 0);
    /* MAX, not a sum. cards_seen is a count of DISTINCT cards under one
       identity; adding two identities' counts together can report more cards
       than the story has. */
    const cards = Number(r.cards_seen || 0);
    if (cards > st.cards) st.cards = cards;
    const far = typeof r.furthest_card === "number" ? r.furthest_card : null;
    if (far !== null && (st.furthest === null || far > st.furthest)) st.furthest = far;
    if (seen > st.last) st.last = seen;
  }

  /* MOST RECENT FIRST, and this line is the definition of the ordinal. It is
     also the line person_timeline depends on: change the comparator and
     every ordinal a dashboard is holding points at somebody else. */
  order.sort(function (a, b) { return a.last < b.last ? 1 : (a.last > b.last ? -1 : 0); });

  return { order: order, ids: ids, truncated: truncated };
}

/* Every batch failed and there was something to ask. The panel's whole point
   is the email column, and a screen of readers labelled "anonymous" because
   Firebase Auth was down is a lie told quietly. Refuse instead. */
async function emailsOrRefuse(ids) {
  const got = await emailsFor(ids);
  if (got.asked > 0 && got.failed >= got.asked) {
    const e = new Error("upstream");
    e.code = "upstream";
    e.reason = "auth_lookup";
    throw e;
  }
  return got;
}

async function shapeReaders(rows, limit) {
  const fold = foldReaders(rows, limit);
  const order = fold.order;
  const truncated = fold.truncated;
  const got = await emailsOrRefuse(fold.ids);

  const out = [];
  let withEmail = 0;
  for (let i = 0; i < order.length; i++) {
    const rec = order[i];
    let email = null;
    for (const id of rec.ids) {
      if (got.map[id]) { email = got.map[id]; break; }
    }
    if (email) withEmail++;
    const label = String(i + 1);
    rec.list.sort(function (a, b) { return a.last < b.last ? 1 : (a.last > b.last ? -1 : 0); });
    for (const st of rec.list) {
      out.push({
        reader: label,
        email: email,
        last_seen: rec.last || null,
        stories: rec.list.length,
        story: st.story,
        opens: st.opens,
        cards_seen: st.cards,
        furthest_card: st.furthest,
        finished: st.completions > 0,
        story_last_seen: st.last || null
      });
    }
  }

  return {
    rows: out,
    meta: {
      readers: order.length,
      with_email: withEmail,
      anonymous: order.length - withEmail,
      truncated: truncated
    }
  };
}

/* ==========================================================================
   GEOGRAPHY — and the check that has to travel with it

   The rows come back with a country name, a country code and three counts.
   Two things happen here, and the second is the important one.

   THE UNKNOWN ROW IS NAMED. Events PostHog could not place come back with
   an empty country and are labelled rather than dropped, because a map
   whose percentages silently exclude the people it could not locate is
   worse than one that admits the hole.

   AND THE ANSWER CARRIES ITS OWN AUDIT. `meta.countries` is how many
   distinct places the window actually contains, and `meta.geo_usable` is
   false when that number is 0 or 1. This site proxies every event through a
   Cloudflare Worker; if that Worker ever stops forwarding the reader's IP,
   the symptom is exactly one country — every reader in the world collapsed
   into a datacentre — and a panel drawn from that would look completely
   normal and be completely false. So the failure is DETECTED here and
   reported as a flag rather than left for someone to notice. A dashboard
   that draws a map without reading `geo_usable` is drawing a lie.

   PEOPLE DO NOT SUM TO THE SITE'S READERS. count(DISTINCT person_id) is per
   country, so one reader who travelled — or turned a VPN on — is counted in
   two rows. `meta.people_rows` is the sum of the column and is not the
   number of readers; `people_pct` is a share of that sum. Both are named
   for what they are.
   ========================================================================== */

function shapeGeo(rows) {
  let total = 0, countries = 0, unknown = 0;
  for (const r of rows) {
    const people = Number(r.people || 0);
    total += people;
    if (!r.country) {
      r.country = GEO_UNKNOWN;
      r.country_code = null;
      r.located = false;
      unknown += people;
    } else {
      r.located = true;
      countries++;
    }
  }
  for (const r of rows) r.people_pct = pct(Number(r.people || 0), total);

  return {
    rows: rows,
    meta: {
      countries: countries,
      people_rows: total,
      unlocated_people_rows: unknown,
      /* One country, or none, means the IP never reached PostHog — see
         cloudflare/posthog-proxy.js. Do not draw a map on a false. */
      geo_usable: countries > 1
    }
  };
}

/* ==========================================================================
   READER DWELL — per reader, per card, and never a mean

   The same three-step shape as shapeReaders: fold on the person, join the
   email out of Firebase Auth, assign an ordinal. The person id and the uid
   do not appear in what is returned; check that again after editing.

   THE ONE THING THAT IS DIFFERENT IS THE ARITHMETIC. Every dwell figure is
   returned twice — raw, and with each individual card view first clipped to
   DWELL_CAP_S — and there is no mean at any level. `dwell_s` is what the
   reader's screen actually showed the card for; `dwell_s_capped` is the
   same sum with an abandoned tab's contribution bounded. They agree for
   almost every reader, and where they disagree loudly that IS the finding:
   somebody left the page open. Reporting only the first would inflate the
   number; reporting only the second would quietly delete real reading.

   PER-READER TOTALS RIDE ON EVERY ROW rather than arriving in a second
   array, which is the shape reader_activity already uses for `stories` and
   `last_seen`. A dashboard grouping rows by `reader` has the header numbers
   in the first row of each group and needs no second lookup.
   ========================================================================== */

function medianOf(values) {
  if (!values.length) return null;
  const v = values.slice().sort(function (a, b) { return a - b; });
  const mid = v.length >> 1;
  const m = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return Math.round(m * 10) / 10;
}

function round1(n) { return Math.round(Number(n || 0) * 10) / 10; }

/* The roster, as a lookup: person id -> the ordinal reader_activity would
   print for them, and the email that goes with it. Built once from the fold
   every personal query shares, so "reader 5" is one person across the whole
   API. Returns a plain object because a person id is a UUID string. */
function rosterIndex(order, emails) {
  const index = Object.create(null);
  for (let i = 0; i < order.length; i++) {
    const rec = order[i];
    if (!rec.person) continue;
    let email = null;
    for (const id of rec.ids) if (emails[id]) { email = emails[id]; break; }
    index[rec.person] = { ordinal: String(i + 1), email: email, last: rec.last || null };
  }
  return index;
}

function shapeReaderDwell(rows, limit, index) {
  const truncated = rows.length > limit;
  const use = truncated ? rows.slice(0, limit) : rows;

  const byPerson = Object.create(null);
  const order = [];
  let unranked = 0;

  for (const r of use) {
    const key = String(r.person || "");
    if (!key) continue;
    /* A card_view whose card did not parse. toInt returned NULL, the row is
       about no card in particular, and there is no honest label for it. */
    if (r.card === null || r.card === undefined) continue;

    /* THE ORDINAL COMES FROM THE ROSTER, NOT FROM COUNTING ROWS HERE. Every
       person with a card_view is in the roster by construction — card_view
       is one of the four events the roster query selects — so the only way
       to miss is a roster that truncated. Those rows are kept and labelled
       `reader: null` rather than dropped: losing a reader's dwell because a
       cap bit is worse than showing it without a number to click. */
    const seat = index[key] || null;
    if (!seat) unranked++;

    let rec = byPerson[key];
    if (!rec) {
      rec = byPerson[key] = {
        reader: seat ? seat.ordinal : null,
        email: seat ? seat.email : null,
        last: "",
        cards: []
      };
      order.push(rec);
    }

    const seen = String(r.last_seen || "");
    if (seen > rec.last) rec.last = seen;

    rec.cards.push({
      /* Empty means the view predates `page` shipping on card_view. It is
         not "the home page" and it is not guessable, so it is named for
         what it is and left alone. */
      page: String(r.page || "") || null,
      story: String(r.story || ""),
      card: Number(r.card),
      views: Number(r.views || 0),
      dwell_s: round1(r.dwell_s),
      dwell_s_capped: round1(r.dwell_s_capped),
      median_dwell_s: r.median_dwell_s === null ? null : round1(r.median_dwell_s),
      longest_dwell_s: r.longest_dwell_s === null ? null : round1(r.longest_dwell_s),
      last_seen: seen || null
    });
  }

  /* Most recent first, the same rule and therefore the same order the
     ordinals were assigned in. A reader the roster could not rank sorts by
     recency with everyone else and simply has no number. */
  order.sort(function (a, b) { return a.last < b.last ? 1 : (a.last > b.last ? -1 : 0); });

  const out = [];
  let withEmail = 0;
  for (const rec of order) {
    const email = rec.email;
    if (email) withEmail++;
    const label = rec.reader;

    /* Reading order — the page, then the story, then the card — because
       "which cards and how long on each" is read down a story, not sorted
       by size. The dashboard can re-sort; it cannot un-sort. */
    rec.cards.sort(function (a, b) {
      const pa = a.page || "", pb = b.page || "";
      if (pa !== pb) return pa < pb ? -1 : 1;
      if (a.story !== b.story) return a.story < b.story ? -1 : 1;
      return a.card - b.card;
    });

    let total = 0, capped = 0, views = 0;
    const each = [];
    for (const c of rec.cards) {
      total += c.dwell_s;
      capped += c.dwell_s_capped;
      views += c.views;
      each.push(c.dwell_s);
    }

    for (const c of rec.cards) {
      out.push({
        reader: label,
        email: email,
        page: c.page,
        story: c.story,
        card: c.card,
        views: c.views,
        dwell_s: c.dwell_s,
        dwell_s_capped: c.dwell_s_capped,
        median_dwell_s: c.median_dwell_s,
        longest_dwell_s: c.longest_dwell_s,
        last_seen: c.last_seen,
        /* The per-reader totals, on every row. Same value in each row of a
           reader's group; a dashboard reads them off the first. */
        reader_cards: rec.cards.length,
        reader_views: views,
        reader_dwell_s: round1(total),
        reader_dwell_s_capped: round1(capped),
        reader_median_card_dwell_s: medianOf(each),
        reader_last_seen: rec.last || null
      });
    }
  }

  return {
    rows: out,
    meta: {
      readers: order.length,
      with_email: withEmail,
      anonymous: order.length - withEmail,
      card_rows: out.length,
      /* Rows whose reader is not on the roster, and therefore carries no
         ordinal. Only reachable when the roster itself truncated. */
      unranked_rows: unranked,
      /* What the clip was, so `_capped` is a stated arithmetic rather than a
         number the dashboard has to trust. */
      dwell_cap_s: DWELL_CAP_S,
      /* A FACT. The query asked for limit + 1 rows and got them, so there
         were more. When this is true the per-reader totals of the readers
         nearest the cut are PARTIAL — the rows are ordered by recency
         across everybody, so a cap cuts a reader's older cards away.
         ANALYTICS-API.md says so beside the query. */
      truncated: truncated
    }
  };
}

/* ==========================================================================
   ONE READER'S TIMELINE — the order, and the gaps

   The rows arrive most recent first, because a cap that bites has to drop
   the oldest events rather than the ones the panel was opened to see. They
   leave oldest first, because "x then y then z" reads downwards.

   THE GAP IS THE ANSWER, not decoration. The owner's phrasing was "and then
   an hour later" — the time BETWEEN two events is the part that says whether
   this was one sitting or somebody coming back. `gap_s` is seconds since the
   previous row and is null on the first, and `session` counts a new visit
   every time that gap passes SESSION_GAP_S, so a dashboard can draw the
   break without re-deriving it from timestamps and getting a different
   answer than this file would.

   `detail` IS BUILT HERE, out of named properties, and never out of a
   property that can hold something a reader typed. client_error.message is
   the one such field on any event this site sends, and it is not read.
   ========================================================================== */

function timelineDetail(r) {
  const ev = String(r.event || "");
  const page = String(r.page || "");
  const story = String(r.story || "");
  const card = (r.card === null || r.card === undefined) ? null : Number(r.card);
  const bits = [];

  if (ev === "card_view") {
    if (story) bits.push("story " + story);
    if (card !== null) bits.push("card " + card);
    if (r.dwell_s !== null && r.dwell_s !== undefined) {
      bits.push(round1(r.dwell_s) + "s on screen");
    }
    if (page) bits.push("on /" + page);
  } else if (ev === "stack_open" || ev === "stack_complete" || ev === "resume_used") {
    if (story) bits.push("story " + story);
    if (card !== null) bits.push("card " + card);
  } else if (ev === "stack_dropoff") {
    if (story) bits.push("story " + story);
    if (card !== null) bits.push("stopped at card " + card);
  } else if (ev === "story_time") {
    if (story) bits.push("story " + story);
    if (r.cards !== null && r.cards !== undefined) {
      const n = Number(r.cards);
      bits.push(n + (n === 1 ? " card" : " cards"));
    }
  } else if (ev === "page_open") {
    if (page) bits.push("/" + page);
  } else if (ev === "ui_click") {
    if (r.control) bits.push("pressed " + String(r.control));
    if (page) bits.push("on /" + page);
  } else if (ev === "join_step" || ev === "join_skip") {
    if (r.step) bits.push(String(r.step));
  } else if (ev === "checkout_start" || ev === "subscribe_click" ||
             ev === "monthly_selected" || ev === "annual_selected") {
    if (r.plan) bits.push(String(r.plan));
  } else if (ev === "checkout_blocked") {
    if (r.why) bits.push(String(r.why));
    if (r.plan) bits.push(String(r.plan));
  } else if (ev === "access_gained") {
    if (r.via) bits.push("via " + String(r.via));
  } else if (ev === "client_error") {
    /* The source and the line, never the message. `client_errors` reports
       that field, grouped, where it is a bug rather than a person. */
    if (r.source) bits.push(String(r.source));
    if (r.line !== null && r.line !== undefined) bits.push("line " + Number(r.line));
    if (page) bits.push("on /" + page);
  } else {
    if (story) bits.push("story " + story);
    if (page) bits.push("on /" + page);
  }
  return bits.join(" · ");
}

function shapeTimeline(rows, limit) {
  /* Asked for limit + 1 in DESC order: an extra row means there is older
     history this response does not contain. A fact, not a guess. */
  const truncated = rows.length > limit;
  const use = (truncated ? rows.slice(0, limit) : rows).slice().reverse();

  const out = [];
  let prev = 0, session = 0;
  let firstAt = null, lastAt = null, cards = 0, dwell = 0, dwellCapped = 0;
  let longestGap = 0;

  for (const r of use) {
    const at = String(r.at || "");
    const t = Date.parse(at);
    const ok = isFinite(t);
    /* Null on the first row, and null on a row whose timestamp did not
       parse — a made-up zero would read as "immediately afterwards". */
    const gap = (ok && prev) ? Math.max(0, Math.round((t - prev) / 1000)) : null;
    if (gap === null || gap >= SESSION_GAP_S) session++;
    if (gap !== null && gap > longestGap) longestGap = gap;

    if (String(r.event) === "card_view") {
      cards++;
      const d = Number(r.dwell_s || 0);
      dwell += d;
      dwellCapped += Math.min(d, DWELL_CAP_S);
    }

    out.push({
      at: at || null,
      event: String(r.event || ""),
      detail: timelineDetail(r),
      gap_s: gap,
      session: session,
      /* The named fields the detail string was built from, so a dashboard
         can lay the timeline out as a table instead of a sentence without
         parsing prose back apart. */
      page: String(r.page || "") || null,
      story: String(r.story || "") || null,
      card: (r.card === null || r.card === undefined) ? null : Number(r.card),
      dwell_s: (r.dwell_s === null || r.dwell_s === undefined) ? null : round1(r.dwell_s)
    });

    if (ok) { prev = t; lastAt = at; if (firstAt === null) firstAt = at; }
  }

  return {
    rows: out,
    meta: {
      sessions: session,
      first_event: firstAt,
      last_event: lastAt,
      longest_gap_s: longestGap,
      card_views: cards,
      reading_s: round1(dwell),
      reading_s_capped: round1(dwellCapped),
      dwell_cap_s: DWELL_CAP_S,
      session_gap_s: SESSION_GAP_S,
      truncated: truncated
    }
  };
}

/* ==========================================================================
   /firststory — folding one row per person into a cohort funnel

   The rows that arrive here each carry a person_id. NOT ONE OF THEM LEAVES:
   this returns funnel steps and nothing else, and the ids are dropped with
   the local variable.

   The cohort is "opened /firststory, or read a card there". Every step is
   counted inside it, so each number is people who did that thing HAVING BEEN
   on the page the launch videos point at — which is the question, and is not
   the same as the site-wide step reach `subscribe_funnel` reports.
   ========================================================================== */

function shapeFirstStory(rows) {
  /* The scan's own cap. Hitting it means the answer is a sample rather than
     the whole window, and the dashboard has to say so rather than draw it. */
  const truncated = rows.length >= FS_PERSON_ROWS;

  const cohort = [];
  let arrivals = 0, cardsHere = 0, cardsStory = 0, cardsPlaced = 0, deepest = 0;

  for (const r of rows) {
    const a = Number(r.arrivals || 0), c = Number(r.cards_here || 0);
    cardsStory += Number(r.cards_story || 0);
    cardsPlaced += Number(r.cards_story_placed || 0);
    if (a > 0 || c > 0) {
      cohort.push(r);
      arrivals += a;
      cardsHere += c;
      const f = Number(r.furthest_card || 0);
      if (f > deepest) deepest = f;
    }
  }

  function people(key) {
    let n = 0;
    for (const r of cohort) if (Number(r[key] || 0) > 0) n++;
    return n;
  }
  function peopleIf(test) {
    let n = 0;
    for (const r of cohort) if (test(r)) n++;
    return n;
  }

  /* The whole journey, in the order it happens, from the page the launch
     videos point at to somebody coming back a day later. Every label says
     what the number IS rather than what it would be nice for it to mean —
     "we sent them" for Stripe, because everything past that request is on
     somebody else's origin and no browser event of ours can see it. */
  const STEPS = [
    ["arrived",         "Opened /firststory",
     (r) => Number(r.arrivals || 0) > 0],
    ["read_a_card",     "Read a card there",
     (r) => Number(r.cards_here || 0) > 0],
    ["reached_the_end", "Reached the end card",
     (r) => Number(r.end_seen || 0) > 0],
    ["opened_the_gate", "Reached the sign-up page",
     (r) => Number(r.gate || 0) > 0],
    ["signed_in",       "Signed in or created an account",
     (r) => Number(r.signed_any || 0) > 0],
    ["reached_stripe",  "Reached Stripe",
     (r) => Number(r.stripe || 0) > 0],
    ["paid",            "Paid and came back with access",
     (r) => Number(r.subscribed || 0) > 0],
    /* Retention, and the one step that is a DEFINITION rather than an event:
       a person active on more than one calendar day inside the window has
       been back at least once after the day they arrived. The definition is
       printed on the page, because "later" is a choice and a retention number
       whose rule is not on screen is a number nobody can argue with. */
    ["came_back_later", "Came back on a later day",
     (r) => Number(r.days_active || 0) > 1]
  ];

  const out = [];
  let first = 0, prev = 0;
  for (const [step, label, test] of STEPS) {
    const n = peopleIf(test);
    if (!out.length) first = n;
    out.push({
      step: step,
      label: label,
      people: n,
      pct_of_first: pct(n, first),
      pct_of_previous: out.length ? pct(n, prev) : 100
    });
    prev = n;
  }

  /* Not steps. `pct_of_previous: null` is how a row says "do not draw me as
     one" — the same signal subscribe_funnel's `blocked` row carries, read
     generically by the dashboard so a context row added later needs no
     change there. */
  /* Short enough to sit in a chart's label column and in a table cell. The
     sentence each of them needs is printed once, under the chart, by
     js/dashboard.js — a label is a name, not a footnote. */
  const CONTEXT = [
    ["end_card_built",       "End card built (early, not seen)", "end_built"],
    ["finished_the_story",   "Finished the story",               "finished_story"],
    ["account_created_email", "Created an account by email",     "account"],
    ["opened_the_home_page", "Opened the home page",             "home_opens"]
  ];
  for (const [step, label, key] of CONTEXT) {
    const n = people(key);
    out.push({
      step: step, label: label, people: n,
      pct_of_first: pct(n, first), pct_of_previous: null
    });
  }

  return {
    rows: out,
    meta: {
      cohort: cohort.length,
      arrivals: arrivals,
      card_views_here: cardsHere,
      card_views_story: cardsStory,
      /* Card views of this story that name no address at all: recorded before
         `page` shipped on card_view, and impossible to attribute now. A
         subtraction rather than a test for absence — a missing property is
         NULL in HogQL, and `NULL = ''` is NULL, so testing for '' would have
         reported zero of these forever. */
      card_views_unattributed: Math.max(0, cardsStory - cardsPlaced),
      deepest_card: deepest,
      truncated: truncated
    }
  };
}

/* ==========================================================================
   THE FIRESTORE-ONLY QUERY

   count() aggregations: a number computed server-side, no document opened, no
   field read but the count. Billed one document read per 1,000 index entries
   matched, so the whole customer base costs single-digit reads.
   ========================================================================== */

async function subscriptionTotals(adminCount) {
  const col = db.collection("customers");
  const [all, prem] = await Promise.all([
    col.count().get(),
    col.where("premium", "==", true).count().get()
  ]);
  const accounts = Number(all.data().count || 0);
  const premium = Number(prem.data().count || 0);
  const out = [
    { metric: "accounts",         label: "Accounts",           value: accounts },
    { metric: "premium_accounts", label: "Subscribers",        value: premium },
    { metric: "premium_pct",      label: "Share subscribing",  value: pct(premium, accounts) }
  ];
  /* THE ADMIN SWITCH DOES NOT APPLY HERE, and this row is why it does not
     apply silently. These are Firestore counts of ACCOUNTS, not counts of
     analytics events: there is no event to leave out, and subtracting the
     founders would stop this being the authoritative subscriber number — the
     one thing it is for. So the totals stay whole and the count of admin
     accounts is returned beside them, which is the fact a reader needs in
     order to do the subtraction themselves and to know it has not been done
     for them. meta.admin_filter says `not_applicable` for the same reason. */
  if (typeof adminCount === "number") {
    out.push({ metric: "admin_accounts",
               label: "Of those, admin accounts", value: adminCount });
  }
  return out;
}

/* ==========================================================================
   THE ENDPOINT
   ========================================================================== */

exports.insights = onRequest(
  {
    region: "us-central1",
    cors: false,                 /* handled above, with an allowlist */
    secrets: [POSTHOG_API_KEY, POSTHOG_PROJECT_ID],
    memory: "256MiB",
    /* Three. The audience is two or three admins looking at a dashboard, and
       maxInstances is the only number that actually caps what a flood can
       spend — everything else caps what it can achieve. */
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 30           /* the upstream hop is bounded at 20s of it */
  },
  async (req, res) => {
    cors(req, res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") {
      return send(res, 405, { ok: false, error: "bad_query", field: "method" });
    }

    /* Before parsing, not after. */
    const len = Number(req.headers["content-length"] || 0);
    if (len > MAX_BODY_BYTES) return fail(res, "bad_query", { field: "body" });

    /* --- 1. Who is asking. Nothing before this costs a read. ------------- */
    const who = await requireAdmin(req);
    if (!who.ok) {
      /* One answer for all four failures. The log knows which. */
      logger.info("insights refused", { why: who.why, uid: who.uid || null });
      return fail(res, "not_admin");
    }

    /* --- 2. What they asked for. ---------------------------------------- */
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const asked = String(body.query || "");
    const name = Object.prototype.hasOwnProperty.call(ALIASES, asked)
      ? ALIASES[asked] : asked;
    if (!Object.prototype.hasOwnProperty.call(QUERIES, name)) {
      return fail(res, "bad_query", { field: "query" });
    }
    const spec = QUERIES[name];
    const raw = (body.params && typeof body.params === "object" && !Array.isArray(body.params))
      ? body.params : {};

    let parsed;
    try {
      parsed = readParams(name, raw);
    } catch (err) {
      logger.info("insights bad param", {
        uid: who.uid, query: name, field: (err && err.field) || null
      });
      return fail(res, "bad_query", { field: (err && err.field) || undefined });
    }

    /* --- 3. What it costs. ----------------------------------------------
       Counted in upstream queries, because person_timeline makes two. */
    /* `twoUpstream` is onboarding_answers: two bounded queries and a join in
       JS, for the same reason reader_dwell makes two — one HogQL query
       cannot both group by (q, answer) and carry a per-person outcome
       without a construct this file has never run. It is not `twoStep`,
       which means something narrower: a roster and an ordinal. */
    const upstreamCost = spec.firestore ? 0
      : (spec.twoStep || spec.twoUpstream ? 2 : 1);

    const localWait = throttledLocally(who.uid);
    if (localWait) return fail(res, "rate_limited", { retry_after_s: localWait });

    const when = new Date();
    try {
      await spendBudget(who.uid, when, upstreamCost);
    } catch (err) {
      if (err && err.code === "rate_limited") {
        return fail(res, "rate_limited", {
          retry_after_s: err.retry ? err.retry : undefined
        });
      }
      logger.error("insights budget failed", { message: err && err.message });
      return fail(res, "upstream", { reason: "counter_unavailable" });
    }

    /* --- 3b. Who to leave out. ------------------------------------------
       Always read, whichever way the switch is set: with it ON the uids
       build the filter, with it OFF the COUNT is still what lets the page
       say "these numbers include N admin accounts" rather than leaving the
       reader to wonder. Cached for a minute, so a seventeen-panel render is
       one collection scan and not seventeen. */
    const wantsExclude = parsed.p.excludeAdmins === true;
    let admins = null;
    try {
      admins = await adminUids(who.uid);
    } catch (err) {
      logger.error("insights admin list failed", { message: err && err.message });
      /* FAIL CLOSED, but only when it matters. With the switch ON, answering
         anyway would put unfiltered numbers on a page that says they are
         filtered, and a number that lies about what it counts is worse than
         no number. With the switch OFF nothing was going to be removed, so
         the only loss is the count, and the answer is still true. */
      if (wantsExclude) return fail(res, "upstream", { reason: "admin_list" });
    }
    parsed.p.adminUids = admins || [];

    /* --- 4. Run it. ------------------------------------------------------ */
    const started = Date.now();
    const days = parsed.p.days || DAYS_DEFAULT;
    const dated = spec.params.indexOf("days") !== -1;
    const meta = {
      query: name,
      /* Null rather than a made-up fortnight for the one query that has no
         date window: subscription_totals counts what is true now. When the
         caller gave dates, these are their dates — `to` is the end of the
         inclusive day, matching what the query actually scanned. */
      from: !dated ? null
          : parsed.p.from ? new Date(parsed.p.from + "T00:00:00Z").toISOString()
          : new Date(when.getTime() - days * 86400000).toISOString(),
      to: !dated ? when.toISOString()
        : parsed.p.to
          ? new Date(Date.parse(parsed.p.to + "T00:00:00Z") + 86400000 - 1).toISOString()
          : when.toISOString(),
      days: dated ? days : null,
      rows: 0,
      limit: parsed.p.limit === undefined ? null : parsed.p.limit,
      params: parsed.echo,
      source: spec.firestore ? "firestore" : "posthog",
      /* What the switch actually DID, said plainly, because the dashboard
         prints it beside every number and a figure whose meaning changed
         without saying so is worse than no figure at all.

           excluded       admin uids were taken out of this query
           included       they were not
           not_applicable subscription_totals — a Firestore count of
                          accounts, with no event to leave out. See
                          subscriptionTotals(). */
      admin_filter: spec.firestore ? "not_applicable"
                  : (wantsExclude && parsed.p.adminUids.length ? "excluded" : "included"),
      /* A COUNT, never the uids. Shipping those to a browser is the mistake
         this whole design exists to avoid. */
      admin_accounts: admins ? admins.length : null,
      took_ms: 0
    };
    /* Only when it was one, so the common case carries no extra key. */
    if (asked !== name) meta.requested = asked;

    let rows;
    let key = "", project = "";
    if (!spec.firestore) {
      key = String(POSTHOG_API_KEY.value() || "");
      project = String(POSTHOG_PROJECT_ID.value() || "");
      /* A personal API key is `phx_…`; anything else, including the empty
         string a never-set secret returns, means "not configured yet". Same
         shape support.js uses for a missing mail key: the function works, the
         admin check works, there is simply nothing upstream to ask. */
      if (!/^phx_[A-Za-z0-9_-]{10,}$/.test(key) || !/^[0-9]{1,12}$/.test(project)) {
        return fail(res, "upstream", { reason: "not_configured" });
      }
    }

    /* One hop upstream, with the one place a failure is turned into a 502.
       Returns null having ALREADY answered the request when it fails, so
       every caller checks for null and returns. */
    async function run(built) {
      try {
        return toRows(await ask(built.sql, key, project), built.columns);
      } catch (err) {
        logger.error("insights upstream failed", {
          query: name,
          reason: (err && err.reason) || "unknown",
          detail: (err && err.detail) || null
        });
        fail(res, "upstream", { reason: (err && err.reason) || undefined });
        return null;
      }
    }

    if (spec.firestore) {
      try {
        rows = await subscriptionTotals(admins ? admins.length : undefined);
      } catch (err) {
        logger.error("insights firestore query failed", {
          query: name, message: err && err.message
        });
        return fail(res, "upstream", { reason: "firestore" });
      }
    } else {
      rows = await run(spec.build(parsed.p));
      if (rows === null) return;
    }

    /* Four queries are folded rather than shaped: three have to await
       Firebase Auth or a second upstream hop, and every one of them carries
       a person id in the rows PostHog returned that must be dropped before
       anything is sent. Each returns its own meta, which is how a caveat
       about an answer travels with the answer. */
    if (name === "reader_activity") {
      let folded;
      try {
        folded = await shapeReaders(rows, parsed.p.limit);
      } catch (err) {
        logger.error("insights reader join failed", {
          reason: (err && err.reason) || "unknown"
        });
        return fail(res, "upstream", { reason: (err && err.reason) || undefined });
      }
      rows = folded.rows;
      for (const k in folded.meta) meta[k] = folded.meta[k];

    } else if (spec.twoStep) {
      /* --- THE ROSTER, AND THE ORDINAL IT DEFINES ----------------------
         `rows` at this point is reader_activity's own query through
         reader_activity's own fold, so "reader 5" here is the same person
         "reader 5" is there. Both two-step queries resolve against it and
         neither invents an ordinal of its own. The person ids live in this
         block and in no response: check that again after editing, because
         it is the whole of the privacy design. */
      const fold = foldReaders(rows, parsed.p.rosterLimit);
      meta.roster_readers = fold.order.length;
      meta.roster_truncated = fold.truncated;

      let got;
      try {
        got = await emailsOrRefuse(fold.ids);
      } catch (err) {
        logger.error("insights reader join failed", {
          reason: (err && err.reason) || "unknown"
        });
        return fail(res, "upstream", { reason: (err && err.reason) || undefined });
      }
      const index = rosterIndex(fold.order, got.map);

      if (name === "reader_dwell") {
        const dwell = await run(spec.buildDwell(parsed.p));
        if (dwell === null) return;
        const folded = shapeReaderDwell(dwell, parsed.p.limit, index);
        rows = folded.rows;
        for (const k in folded.meta) meta[k] = folded.meta[k];

      } else {
        /* person_timeline: one seat on that roster, resolved here. */
        const rec = fold.order[parsed.p.reader - 1] || null;
        if (!rec || !rec.person) {
          /* Not an error. The table was drawn, somebody else read a card,
             and the row that was 7th is 8th. Say so, answer with no rows. */
          meta.reader_found = false;
          meta.reader_email = null;
          meta.reader_last_seen = null;
          rows = [];
        } else {
          const seat = index[rec.person] || {};
          /* WHO IT RESOLVED TO, so a dashboard can print the name beside
             the timeline and a human can see it is still the row they
             clicked. The email, which reader_activity already shows for
             this reader — never the uid and never the person id. */
          meta.reader_found = true;
          meta.reader_email = seat.email === undefined ? null : seat.email;
          meta.reader_last_seen = rec.last || null;
          meta.reader_stories = rec.list.length;

          const events = await run(spec.buildEvents(parsed.p, rec.person));
          if (events === null) return;
          const folded = shapeTimeline(events, parsed.p.limit);
          rows = folded.rows;
          for (const k in folded.meta) meta[k] = folded.meta[k];
        }
      }

    } else if (name === "firststory_funnel") {
      const folded = shapeFirstStory(rows);
      rows = folded.rows;
      for (const k in folded.meta) meta[k] = folded.meta[k];
    } else if (name === "geo_breakdown") {
      const folded = shapeGeo(rows);
      rows = folded.rows;
      for (const k in folded.meta) meta[k] = folded.meta[k];

    /* --- The quiz funnel ------------------------------------------------
       Four folds rather than four cases in shape(), for the reason the
       three above are folds: each carries a caveat about its own answer —
       whether a percentage may be printed at all, which declared screens
       never fired, whether a row bound was hit — and a caveat that does not
       travel with the answer is a caveat nobody reads. Two of them also
       carry a person id in what PostHog returned, and it must be dropped
       before anything is sent. */
    } else if (name === "onboarding_steps") {
      const folded = shapeOnboardingSteps(rows);
      rows = folded.rows;
      for (const k in folded.meta) meta[k] = folded.meta[k];
    } else if (name === "onboarding_conversion") {
      const folded = shapeOnboarding(rows);
      rows = folded.rows;
      for (const k in folded.meta) meta[k] = folded.meta[k];
    } else if (name === "onboarding_runs") {
      const folded = shapeOnboardingRuns(rows);
      rows = folded.rows;
      for (const k in folded.meta) meta[k] = folded.meta[k];
    } else if (name === "onboarding_answers") {
      /* The second call is budgeted for above whether or not it is reached,
         which is the honest direction to round: an admin who asked for this
         is charged for what it costs, not for how far it got. */
      const outcomes = await run(spec.buildOutcomes(parsed.p));
      if (outcomes === null) return;
      const folded = shapeOnboardingAnswers(rows, outcomes, parsed.p.limit);
      rows = folded.rows;
      for (const k in folded.meta) meta[k] = folded.meta[k];
    } else {
      rows = shape(name, rows);
    }

    meta.rows = rows.length;
    meta.took_ms = Date.now() - started;

    /* The uid, the query name and a row count. Not a row, not a parameter that
       could be a story someone is reading, and nothing a reader ever typed. */
    logger.info("insights", {
      uid: who.uid, query: name, rows: rows.length, ms: meta.took_ms,
      admin_filter: meta.admin_filter
    });

    /* An audit line of its own for the one query that returns people. Which
       admin, how many readers, how many emails — and no email, no uid and no
       story in it. A personal-data read that leaves no trace is one nobody
       can answer a question about later. */
    if (spec.personal) {
      logger.info("insights personal", {
        uid: who.uid, query: name,
        readers: meta.readers === undefined ? null : meta.readers,
        emails: meta.with_email === undefined ? null : meta.with_email,
        /* person_timeline read ONE person. Which ordinal was asked for and
           whether it resolved — never the email, never the uid, never the
           person id. An ordinal in a log is a number; the thing that makes
           it mean a person is the roster, and the roster is not stored. */
        reader: parsed.echo.reader === undefined ? null : parsed.echo.reader,
        reader_found: meta.reader_found === undefined ? null : meta.reader_found,
        rows: rows.length,
        admin_filter: meta.admin_filter
      });
    }

    return send(res, 200, { ok: true, query: name, rows: rows, meta: meta });
  }
);

/* --- Exported for a test, and for nothing else --------------------------
   `functions/index.js` takes `.insights` and only `.insights`, so nothing
   added here is deployed as a function or reachable over HTTP. These are the
   parts worth pointing a test at without a key, a network or an admin
   account: the thing that decides whether a stranger's punctuation may reach
   a query at all, the parameter reader, and the query table itself. */
exports._lit = lit;
exports._likeLit = likeLit;
exports._ALIASES = ALIASES;
exports._readParams = readParams;
exports._QUERIES = QUERIES;
exports._KNOWN_EVENTS = KNOWN_EVENTS;
exports._shape = shape;
exports._shapeFirstStory = shapeFirstStory;
exports._shapeReaders = shapeReaders;
exports._foldReaders = foldReaders;
exports._shapeReaderDwell = shapeReaderDwell;
exports._rosterIndex = rosterIndex;
exports._shapeTimeline = shapeTimeline;
exports._shapeGeo = shapeGeo;
exports._shapeOnboardingSteps = shapeOnboardingSteps;
exports._shapeOnboarding = shapeOnboarding;
exports._shapeOnboardingAnswers = shapeOnboardingAnswers;
exports._shapeOnboardingRuns = shapeOnboardingRuns;
exports._OB_STEPS = OB_STEPS;
exports._PCT_MIN_PEOPLE = PCT_MIN_PEOPLE;
exports._timelineDetail = timelineDetail;
/* alerts.js needs the SAME admin list this file uses, not a second copy of
   the logic. A divergence here does not fail loudly — it fails by the
   launch alarm quietly starting to fire on the founders' own browsing,
   which is the one outcome that makes the alarm worthless. So it is
   exported rather than duplicated, and alerts.js throws rather than
   building an unfiltered query if this is ever missing. */
exports._adminUids = adminUids;
exports._notAdmins = notAdmins;
exports._boolParam = boolParam;
