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
   admin, pick one of fourteen queries THIS FILE wrote, run it against PostHog
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
      "the key is read-only" is not a defence. The eleven query texts are string
      constants below. A caller sends a NAME and typed VALUES, and every value
      is checked against a character set that contains no quote, no backslash,
      no brace, no semicolon and no comma before it is placed into a query — and
      re-checked by `lit()` at the moment of placement, so a future edit that
      forgets to validate still cannot produce an injection.

   3. NO IDENTITY LEAVES THE FUNCTION, WITH ONE DELIBERATE EXCEPTION.
      There is no `SELECT *` in this file. Every column is named. Of the
      fourteen queries, thirteen select no `distinct_id`, no `person_id`, no
      `$ip`, no email and no person property: people are counted with
      `count(DISTINCT person_id)` and the COUNT is returned. The one query that
      reads Firestore uses `count()` aggregations, which return a number without
      opening a document.

      `reader_activity` IS THE EXCEPTION, AND IT IS ON PURPOSE. The owner asked
      to see "the emails / accounts and which stories they viewed, how far they
      got" — with a handful of readers, an aggregate percentage says nothing and
      a list of people says everything. So one query returns one email per
      reader. Four things keep it narrow:

        * THE EMAIL NEVER COMES FROM POSTHOG. It is not there and must not be
          put there. PostHog knows the uid, because js/analytics.js calls
          identify(uid); Firebase Auth knows uid -> email. This function holds
          admin credentials for both and does the join itself, in memory, per
          request. Nothing is written anywhere.
        * THE UID NEVER REACHES THE BROWSER. Rows carry an opaque ordinal
          ("1", "2", ...) that is assigned per response and is not stable
          between two responses, so it cannot be used to follow anyone. It
          exists only so the dashboard can group a reader's story rows.
        * A READER WITH NO ACCOUNT STAYS ANONYMOUS. `email` is null and the
          behaviour is intact. Nothing is invented to fill the column.
        * IT IS BOUNDED AND IT IS LOGGED. A row cap, most-recent-first
          ordering, and a log line naming the admin who asked — see
          READER_ROWS below and the `insights personal` line in the endpoint.

      ANALYTICS-API.md 6 says the same thing in the contract, because a
      reader of that file must not conclude from thirteen queries that the
      fourteenth is impossible.

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
   cache a single render is fourteen panels x one collection scan; with it,
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
  "stack_complete", "stack_dropoff", "stack_open", "story_time",
  "subscribe_click", "trial_cta_clicked", "ui_click"
];

/* ==========================================================================
   THE QUERIES

   Eleven. Each is a function of already-validated parameters returning
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
  event_volume: {
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
     other thirteen queries keep.

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
    build: (p) => ({
      columns: ["person", "reader", "story", "opens", "completions",
                "cards_seen", "furthest_card", "last_seen"],
      sql:
        "SELECT person_id AS person," +
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
        " ORDER BY last_seen DESC LIMIT " + num(p.limit + 1)
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
function readWindow(raw, p, echo) {
  const from = dateParam(raw.from, "from");
  const to = dateParam(raw.to, "to");

  if (!from && !to) {
    p.days = intParam(raw.days, DAYS_MIN, DAYS_MAX, DAYS_DEFAULT, "days");
    echo.days = p.days;
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

  p.from = a;
  p.to = b;
  p.days = Math.min(DAYS_MAX, Math.max(DAYS_MIN, span));
  echo.from = a;
  echo.to = b;
  echo.days = p.days;
}

function readParams(name, raw) {
  const want = QUERIES[name].params || [];
  const p = {};
  const echo = {};

  for (const key of want) {
    switch (key) {
      case "days":
        readWindow(raw, p, echo);
        break;
      case "limit": {
        /* reader_activity counts (person, id, story) triples rather than
           rows-a-human-reads, so a story-per-reader multiplies them; its cap
           is its own. Everything else keeps the published 1–200. */
        const hi = name === "reader_activity" ? READER_ROWS_MAX : LIMIT_MAX;
        const dflt = name === "reader_activity" ? READER_ROWS_DEFAULT : LIMIT_DEFAULT;
        p.limit = intParam(raw.limit, LIMIT_MIN, hi, dflt, "limit");
        echo.limit = p.limit;
        break;
      }
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
   saving fourteen collection scans per render. maxInstances is 3, so the
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
async function spendBudget(uid, when, wantsUpstream) {
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
    const upstreamToday = q.day === day ? Number(q.upstream || 0) : 0;
    if (wantsUpstream && upstreamToday >= GLOBAL_PER_DAY) throw deny("rate_limited", 0);

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
      upstream: upstreamToday + (wantsUpstream ? 1 : 0),
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

async function shapeReaders(rows, limit) {
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
      rec = byPerson[key] = { ids: [], last: "", stories: Object.create(null), list: [] };
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

  const got = await emailsFor(ids);
  /* Every batch failed and there was something to ask. The panel's whole
     point is the email column, and a screen of readers labelled "anonymous"
     because Firebase Auth was down is a lie told quietly. Refuse instead. */
  if (got.asked > 0 && got.failed >= got.asked) {
    const e = new Error("upstream");
    e.code = "upstream";
    e.reason = "auth_lookup";
    throw e;
  }

  order.sort(function (a, b) { return a.last < b.last ? 1 : (a.last > b.last ? -1 : 0); });

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

    /* --- 3. What it costs. ---------------------------------------------- */
    const wantsUpstream = !spec.firestore;

    const localWait = throttledLocally(who.uid);
    if (localWait) return fail(res, "rate_limited", { retry_after_s: localWait });

    const when = new Date();
    try {
      await spendBudget(who.uid, when, wantsUpstream);
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
       reader to wonder. Cached for a minute, so a fourteen-panel render is
       one collection scan and not fourteen. */
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
      const key = String(POSTHOG_API_KEY.value() || "");
      const project = String(POSTHOG_PROJECT_ID.value() || "");
      /* A personal API key is `phx_…`; anything else, including the empty
         string a never-set secret returns, means "not configured yet". Same
         shape support.js uses for a missing mail key: the function works, the
         admin check works, there is simply nothing upstream to ask. */
      if (!/^phx_[A-Za-z0-9_-]{10,}$/.test(key) || !/^[0-9]{1,12}$/.test(project)) {
        return fail(res, "upstream", { reason: "not_configured" });
      }

      const built = spec.build(parsed.p);
      let answer;
      try {
        answer = await ask(built.sql, key, project);
      } catch (err) {
        logger.error("insights upstream failed", {
          query: name,
          reason: (err && err.reason) || "unknown",
          detail: (err && err.detail) || null
        });
        return fail(res, "upstream", { reason: (err && err.reason) || undefined });
      }
      rows = toRows(answer, built.columns);
    }

    /* Two queries are folded rather than shaped: one has to await Firebase
       Auth, and both carry a person id in the rows PostHog returned that must
       be dropped before anything is sent. Both return their own meta, which
       is how a caveat about the answer travels with the answer. */
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
    } else if (name === "firststory_funnel") {
      const folded = shapeFirstStory(rows);
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
exports._notAdmins = notAdmins;
exports._boolParam = boolParam;
