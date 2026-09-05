/* ==========================================================================
   Factbox — the launch alarm.

   Two videos went out and nobody has arrived: zero /firststory opens in
   thirty hours. This is not a reporting tool. It is a thing that goes off the
   morning that changes, and then shuts up.

   THREE ALERTS, and they are not built the same way because they are not the
   same kind of fact:

     1. Somebody opened /firststory.        PostHog, on a schedule.
     2. Somebody reached the login page.    PostHog, on a schedule.
     3. Somebody created an account.        Firebase Auth, the moment it
                                            happens. Exact, immediate, no
                                            polling and no analytics in it.

   Alert 3 is the good one and it is deliberately not built like the other
   two. An account is a row in Firebase Auth, so the truth is local, arrives
   as an event, and cannot be lost to an ad blocker, a closed tab or the
   10-25% that client-side analytics costs. Alerts 1 and 2 have no such
   record — the only place they exist is PostHog — so they are polled.

   IT IS NOT A BLOCKING TRIGGER. `beforeUserCreated` (v2, identity) would also
   fire on account creation, and a blocking function that throws STOPS THE
   SIGN-UP. A mail provider having an afternoon must never be able to prevent
   somebody joining the site. So this is the v1 background trigger, which runs
   after the account exists and cannot affect whether it does. That is the
   same instinct as support.js's "store first, mail second, and never let the
   mail decide the answer", applied to the one path where the answer is a
   person getting an account at all.

   --- THE ONE THING THAT MATTERS MOST -------------------------------------

   THE OWNER AND KATHRYN ARE THE ONLY PEOPLE USING THIS SITE. An alarm that
   goes off on their own testing is worse than no alarm: it gets ignored
   within a day, and the day it is ignored is the day a real person arrives.
   So every path here would rather send NOTHING than send something it cannot
   stand behind.

   What that means concretely, in descending order of how much it holds:

   • Admins are excluded by uid, using insights.js's `adminUids()` — the same
     list the dashboard's "leave us out" switch uses, so the two can never
     disagree about who counts. IF THAT LIST CANNOT BE READ, NO MAIL GOES OUT
     AT ALL. It is not a filter that degrades to "off" quietly; it fails
     closed, loudly, and the alert is still written to Firestore so nothing is
     lost. See adminList() and the header comment on it.

   • A SIGNED-OUT BROWSER OF THEIR OWN IS INDISTINGUISHABLE FROM A STRANGER,
     and this file does not pretend otherwise. The exclusion matches on
     `distinct_id`, which is a Firebase uid only after js/analytics.js has
     called identify(uid) — i.e. only once signed in. ANALYTICS-API.md §4
     already says this about the dashboard and it is the same limit here, but
     it bites harder: a dashboard with the founders' own pageviews in it is a
     slightly wrong number, whereas an ALARM with the founders' own pageviews
     in it is a false alarm. There is nothing in the event stream that
     separates the owner's logged-out phone from a stranger's. ALERTS.md says
     so in the same words, and names the one real mitigation — the site's
     existing opt-out, `fb_analytics_optout_v1` in localStorage, set once per
     browser they test from.

   • Browser automation is already excluded, but only by accident of where it
     runs. js/analytics.js refuses to send anything unless the hostname is
     factbox.app or www.factbox.app (or `fb_analytics_local=1` is set on
     purpose). A headless browser on 127.0.0.1 is therefore invisible here —
     this is the fix for the afternoon that put 500-odd robot "users" into the
     dashboard. A headless browser pointed at PRODUCTION is not excluded and
     looks exactly like a stranger. Do not drive the live site to test this.

   • ONE ALERT PER TYPE PER UTC DAY. The first arrival is the news; the
     eleventh that morning is not, and forty emails is worse than none. The
     mail says how many there were, rather than being sent once each.

   --- WHAT STOPS IT REPORTING THE SAME ARRIVAL TWICE ----------------------

   A watermark in Firestore, at `alerts_meta/state`, not a variable in this
   process. Two different things could double-report and they need two
   different answers:

     • The same arrival counted in two consecutive checks — solved by the
       watermark: an alert fires only if some qualifying event is STRICTLY
       newer than the last checked-through instant.
     • A second email about the same morning — solved by the per-day marks in
       the same document.

   Both live in Firestore, so both survive a cold start, a redeploy, a second
   instance, and this file being edited. Neither is in memory anywhere.

   --- COST ----------------------------------------------------------------

   Every fifteen minutes, forever, is a standing bill and a standing quota
   draw, so it is bounded twice: MAX_UPSTREAM_PER_DAY caps what a bad day can
   spend at PostHog, MAX_MAIL_PER_DAY caps what it can spend at Resend, and
   `maxInstances: 1` means two runs can never overlap. Ninety-six runs a day
   is inside every free tier on every line; ALERTS.md does the arithmetic.

   --- NODE 20 -------------------------------------------------------------

   `functions/package.json` pins node 20, which Cloud Functions decommissions
   on 30 October 2026. Noted, not migrated. This file adds NO DEPENDENCY and
   uses nothing newer than global `fetch`, so it moves to node 22 whenever the
   other five move, in one change.
   ========================================================================== */

"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const functionsV1 = require("firebase-functions/v1");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* --- Borrowed from insights.js, not reimplemented ------------------------
   The rule in this project is that two files never hold two opinions about
   the same fact. `lit()` is the quoting guard every value placed into a
   HogQL string goes through, and `notAdmins()` is the exact WHERE fragment
   the dashboard's admin-exclusion switch appends. Importing them means the
   alarm and the dashboard cannot drift into disagreeing about who is a
   stranger.

   `_adminUids` IS THE ONE THIS FILE NEEDS AND CANNOT HAVE YET. insights.js
   exports `_notAdmins` (which BUILDS the clause from a list) but not
   `adminUids` (which READS the list). Writing a second reader here was the
   obvious move and is the wrong one: if insights.js ever changes what counts
   as an admin, the copy would silently diverge, and the direction it would
   diverge in is "the alarm starts firing on the owner". So it is imported
   optionally, and its absence fails closed — see adminList(). One line in
   insights.js turns this on:

       exports._adminUids = adminUids;

   ALERTS.md carries that line and nothing else is needed with it. */
const insights = require("./insights");
const lit = insights._lit;
const notAdmins = insights._notAdmins;

/* --- Secrets ------------------------------------------------------------
   All three already exist in Secret Manager; this file creates none and the
   repository is public, so none of them may ever appear in a file here.
   RESEND_API_KEY still holds the placeholder `disabled-see-SUPPORT-EMAIL.md`,
   which is read as "off" — see mailOn(). */
const POSTHOG_API_KEY = defineSecret("POSTHOG_API_KEY");
const POSTHOG_PROJECT_ID = defineSecret("POSTHOG_PROJECT_ID");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

/* --- Where things live --------------------------------------------------
   `alerts/{stamp-xxxx}` is the archive: one document per alert RAISED,
   whether or not it was mailed, holding the exact subject and body. It is
   what makes an alert recoverable while the mail key is a placeholder. It
   carries no `expiresAt` and no TTL on purpose — the whole point of it is to
   still be there when somebody comes looking.

   `alerts_meta/state` is one singleton document holding the watermark, the
   per-day marks and the day's counters, together, because they are read and
   written in the same transaction and splitting them would make two. */
const COLLECTION = "alerts";
const STATE_DOC = "alerts_meta/state";

/* --- Who to tell --------------------------------------------------------
   A NAMED CONSTANT, and never a value from anywhere else. This is a
   different address from support.js's hello@factbox.app, which is a
   Cloudflare Email Routing forwarder; this one is the owner's personal
   mailbox, because a launch alarm that lands in a shared support inbox is an
   alarm nobody is holding.

   `to` being a constant is the same rule support.js states at length: a `to`
   that anything else can influence is an open relay sending spam from our own
   domain and our own reputation. Nothing in this file computes it, and no
   reader input reaches any header — see alertMail(). */
const ALERT_TO = "hassanjkhan6@gmail.com";

/* Same verified sending domain as support.js. `send.factbox.app`, never the
   root — SUPPORT-EMAIL.md §3 explains why at length, and the short version is
   that the root's single SPF record is what makes hello@factbox.app receive
   mail at all. A second sender on the same subdomain needs no new DNS. */
const MAIL_FROM = "Factbox alerts <alerts@send.factbox.app>";
const MAIL_ENDPOINT = "https://api.resend.com/emails";
const MAIL_TIMEOUT_MS = 5000;

/* --- The three signals --------------------------------------------------
   The keys are the per-day marks in the state document, so renaming one
   silently reopens the once-a-day cap for a day. They do not get renamed. */
const ARRIVAL = "arrival";
const LOGIN = "login";
const SIGNUP = "signup";
const SIGNALS = [ARRIVAL, LOGIN, SIGNUP];

/* --- What counts as which ----------------------------------------------
   These are `page_open`'s `page` property, which js/analytics.js derives from
   the last path segment with the extension stripped (pageName(), ~line 730).
   ANALYTICS-API.md does not enumerate the values — it names `firststory` and
   nothing else — so these are read off the client, not off a contract, and
   are worth checking if a page is ever renamed.

   NO NEW EVENT NAMES. All three are existing events with existing properties:
   `page_open`, `card_view` and `stack_complete`, exactly as the dashboard's
   firststory_funnel already reads them.

   `join` is in with `login` for the second alert. The owner asked about "if
   they make it to log in", and the site has two doors to that: /login, and
   the sign-up pane inside /join, which is where the end card of /firststory
   sends people. Counting only one of them would answer the question wrongly
   about half the time, so both are counted and the mail breaks them out. */
const FIRSTSTORY_PAGE = "firststory";
const FIRSTSTORY_STACK = "01";
const LOGIN_PAGE = "login";
const JOIN_PAGE = "join";

/* --- Bounds -------------------------------------------------------------

   MAX_UPSTREAM_PER_DAY is the cost cap, and it is a cap on the third party
   rather than on us: 96 scheduled runs a day plus headroom. Past it the
   function still runs, still reads its own state, and does not call PostHog.
   A bad day therefore costs 120 queries, not an unbounded number.

   MAX_MAIL_PER_DAY is an EMERGENCY CEILING and deliberately not the design
   cap. The design cap is three a day — three alerts, one each — and it is
   enforced by the per-signal marks in the state document, which is where it
   belongs. This number exists only for the case where those marks are wrong,
   and it is set well above three ON PURPOSE: a shared counter set AT the
   design maximum can be exhausted by the two lesser alerts and then starve
   the signup alert, which is the most valuable of the three. A ceiling that
   can silence the alarm it is protecting is not a safety feature. Ten bounds
   a runaway at ten emails rather than forty, cannot be reached in correct
   operation, and shares Resend's free allowance with support.js, which caps
   itself at 80 a day against a provider ceiling of 100.

   MAX_PERSON_ROWS bounds the response rather than the scan. At a real launch
   this is hundreds of people a day; five hundred rows is far past the point
   where the answer stops being "somebody arrived". */
const MAX_UPSTREAM_PER_DAY = 120;
const MAX_MAIL_PER_DAY = 10;
const MAX_PERSON_ROWS = 500;

/* PostHog ingests events after they happen, and a phone that was in a tunnel
   ingests them a good deal after. Reading right up to `now` and then moving
   the watermark to `now` would drop anything that landed in the last few
   seconds, permanently. So every check stops two minutes short and the
   watermark moves to there. On a fifteen-minute alarm two minutes is nothing;
   what it buys is that the common case of late ingestion is inside the next
   window rather than behind the watermark.

   THE HONEST LIMIT, because two minutes is not infinity: an event ingested
   more than two minutes after its own timestamp, and after the watermark has
   passed it, is not alerted on. It is still in PostHog and still in the
   dashboard. This is an alarm, not an accounting system. */
const LAG_MS = 2 * 60 * 1000;

const UPSTREAM_TIMEOUT_MS = 20 * 1000;
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
const PH_HOST = "https://us.posthog.com";
const AUTH_BATCH = 100;

/* ==========================================================================
   TIME

   UTC everywhere, which is how support.js counts a day, how insights.js
   counts a day, and how Resend rolls its own daily allowance. One clock.
   ========================================================================== */

/* 'YYYY-MM-DD hh:mm:ss' — the form that goes INTO the query, and exactly the
   character set lit() permits, which is not a coincidence: it means an instant
   can be placed into a query through the same guard as every other value. */
function chTime(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/* Every cutoff is snapped DOWN to a whole second before it is used, so the
   query's boundary and the watermark describe the same instant exactly. Where
   this matters is below. */
function wholeSecond(d) {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

/* --- Why watermarks are compared at microsecond width --------------------

   PostHog's `timestamp` is a DateTime64, so `toString()` of it comes back as
   '2026-09-05 16:25:29.366000' — SIX DECIMAL PLACES. The watermark is written
   from a JavaScript Date and has none. Comparing those two as plain strings
   is a trap that only shows up at a second boundary, and it only shows up in
   one direction:

       '2026-09-05 21:49:52.100000' > '2026-09-05 21:49:52'    ->  true

   The longer string wins on the shared prefix, so an event in the SAME SECOND
   as the watermark reads as newer than it and gets reported a second time.
   Truncating both to seconds instead swaps the bug for the opposite one: the
   query window is `timestamp < cutoff`, so an event at 21:49:52.5 is excluded
   from the window that ends at 21:49:52 and would then compare EQUAL to the
   watermark in the next window and never be reported at all.

   So both sides are normalised to a fixed 26 characters — seconds, a dot, six
   digits — and cutoffs are snapped to whole seconds. Then '….52.500000' is
   correctly newer than the watermark '….52.000000', and '….51.900000', which
   was inside the previous window, correctly is not. Fixed width also means
   the comparison is a plain lexicographic one with no date parsing in it.

   This was found by running the real query against real PostHog. A stub that
   returns second-precision strings agrees with itself and proves nothing. */
function stamp(v) {
  let sv = String(v == null ? "" : v).trim();
  const dot = sv.indexOf(".");
  let secs = dot === -1 ? sv : sv.slice(0, dot);
  let frac = dot === -1 ? "" : sv.slice(dot + 1).replace(/[^0-9]/g, "");
  if (!secs) return "";
  secs = secs.slice(0, 19);
  frac = (frac + "000000").slice(0, 6);
  return secs + "." + frac;
}
function utcDay(d) {
  return d.toISOString().slice(0, 10);
}
function dayStartOf(d) {
  return utcDay(d) + " 00:00:00";
}

/* A document id that sorts, for the same reason support.js has one: the
   Firebase console lists documents by id, so a random auto-id is an archive
   in no order at all. The four random characters stop two alerts raised in
   the same second from colliding; they are not secrecy. */
function docId(when) {
  const stamp = when.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  let tail = "";
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  for (let i = 0; i < 4; i++) tail += abc[Math.floor(Math.random() * abc.length)];
  return stamp + "-" + tail;
}

/* ==========================================================================
   THE ADMIN LIST — and why its absence is a refusal, not a default

   Returns an array of uids, or NULL meaning "cannot say". Null is not the
   same as an empty array and the two must never be conflated:

     []    would mean "there are no admins", which is FALSE — the owner is
           one — so an empty list coming back is itself a failure and is
           returned as null.
     null  means the exclusion cannot be applied, and every caller here
           treats that as "do not mail".

   That is the whole cry-wolf defence in one function. An alarm that quietly
   stops excluding the people it is meant to exclude does not look broken; it
   looks like a launch. It would go off on the owner's own morning of testing
   and be believed once, and ignored ever after.
   ========================================================================== */

async function adminList() {
  const fn = insights && insights._adminUids;
  if (typeof fn !== "function") {
    logger.error("alerts: insights.js does not export _adminUids, so admins " +
      "cannot be excluded and nothing will be mailed. Add " +
      "`exports._adminUids = adminUids;` to functions/insights.js — see ALERTS.md.");
    return null;
  }
  try {
    /* No caller uid: there is no caller. adminUids('') returns the list as
       read from `customers`, with nothing appended. */
    const ids = await fn("");
    if (!Array.isArray(ids) || !ids.length) {
      logger.error("alerts: the admin list came back empty, which cannot be " +
        "right, so nothing will be mailed", { got: Array.isArray(ids) ? ids.length : typeof ids });
      return null;
    }
    return ids;
  } catch (err) {
    logger.error("alerts: could not read the admin list, so nothing will be mailed",
      { message: err && err.message });
    return null;
  }
}

/* --- The other half of the same defence, for alert 3 --------------------

   A BRAND-NEW ACCOUNT IS NEVER ALREADY AN ADMIN, so a uid filter cannot
   catch the owner making one more test account — which is by far the likeliest
   false positive on the signup alert. What does catch it is the address: the
   admins' own email addresses, out of Firebase Auth, plus ALERT_TO itself,
   which is the owner by definition.

   Normalised before comparing, because `hassan.j.khan+test2@gmail.com` and
   `hassanjkhan@gmail.com` are one mailbox at Gmail and a signup alert that
   cannot see that is a signup alert that fires on a plus-address. Dots and a
   `+tag` are stripped for gmail/googlemail; only the tag is stripped
   elsewhere, because dots are significant at most other providers.

   Returns null on any lookup failure — fails closed, same as adminList(). */
function normEmail(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return "";
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return local + "@" + domain;
}

async function ownEmails(uids) {
  const out = Object.create(null);
  const seed = normEmail(ALERT_TO);
  if (seed) out[seed] = 1;

  for (let i = 0; i < uids.length; i += AUTH_BATCH) {
    const batch = uids.slice(i, i + AUTH_BATCH).map((uid) => ({ uid: String(uid) }));
    try {
      const res = await admin.auth().getUsers(batch);
      for (const u of (res && res.users) || []) {
        const n = normEmail(u && u.email);
        if (n) out[n] = 1;
      }
    } catch (err) {
      /* A gap here is not a gap in a column, it is a gap in the filter, and
         the filter is the only thing keeping this alarm honest. */
      logger.error("alerts: could not resolve admin emails, so nothing will be mailed",
        { message: err && err.message });
      return null;
    }
  }
  return out;
}

/* ==========================================================================
   THE STATE DOCUMENT

   {
     day:            "2026-09-05",           // UTC; everything below resets with it
     arrivalThrough: "2026-09-05 18:00:00",  // watermarks, ClickHouse format
     loginThrough:   "2026-09-05 18:00:00",
     sent:   { arrival: Timestamp|null, login: ..., signup: ... },
     seen:   { arrival: 3, login: 1, signup: 0 },   // today's totals, for the record
     checks: 41,      // scheduled runs today
     upstream: 41,    // PostHog queries today   -> MAX_UPSTREAM_PER_DAY
     mailed: 2,       // alert emails today      -> MAX_MAIL_PER_DAY (a ceiling,
                      //                             not the cap; `sent` is the cap)
     lastCheckAt, updatedAt
   }

   The watermarks are deliberately NOT reset when the day rolls. A day
   boundary is a fact about the calendar; it is not a reason to re-report
   something already reported. The per-day marks reset, the watermark does
   not, and those two sentences are the whole difference between "one alert a
   day" and "the same arrival every morning".
   ========================================================================== */

function blankState() {
  return {
    day: "",
    arrivalThrough: "",
    loginThrough: "",
    sent: { arrival: null, login: null, signup: null },
    seen: { arrival: 0, login: 0, signup: 0 },
    checks: 0,
    upstream: 0,
    mailed: 0
  };
}

/* Reads a stored document into the shape above, whatever is missing from it,
   and rolls the per-day fields when the date has changed. Never mutates its
   argument; returns a fresh object. */
function rollDay(stored, day) {
  const s = blankState();
  const cur = stored || {};
  s.day = day;
  /* Watermarks survive the roll. See the block comment above. */
  s.arrivalThrough = typeof cur.arrivalThrough === "string" ? cur.arrivalThrough : "";
  s.loginThrough = typeof cur.loginThrough === "string" ? cur.loginThrough : "";

  if (cur.day === day) {
    const sent = cur.sent || {};
    const seen = cur.seen || {};
    for (const k of SIGNALS) {
      s.sent[k] = sent[k] || null;
      s.seen[k] = Number(seen[k] || 0) || 0;
    }
    s.checks = Number(cur.checks || 0) || 0;
    s.upstream = Number(cur.upstream || 0) || 0;
    s.mailed = Number(cur.mailed || 0) || 0;
  }
  return s;
}

/* ==========================================================================
   MAIL

   The same shape as support.js's sender, for the same reasons, and it is a
   second function rather than an import because support.js exports
   `_mailPayload`, `_MAIL_TO` and `_replyTo` and does NOT export `sendMail`,
   `mailKey` or `mailOn`. Importing was the intent; the export is not there.
   ALERTS.md carries the one line that would let this be deleted:

       exports._sendMail = sendMail;

   Until then the duplication is disclosed rather than hidden, and it is the
   cheap half to duplicate: if the two senders ever drift, the cost is an
   alert email that does not send, which is logged and whose text is already
   in Firestore. What was NOT duplicated is the admin list, because the cost
   of that drifting is an alarm that fires on the owner.

   What is carried over exactly:

   • The JSON API, not SMTP. `to`, `subject` and `from` are JSON fields, so
     there is no header line for a CRLF to split even if one reached here.
   • `to` is a constant. Nothing computes it.
   • NOTHING FROM OUTSIDE REACHES A HEADER. The subject is built from a
     constant and integers this file counted. The one string from outside —
     a new account's email address — goes in the BODY, on one line, and never
     in the subject. There is no reply_to on any of these; there is nobody to
     reply to.
   • Text only. No `html` field is sent at all.
   • It never throws, and it never retries. A failed alert email is an ERROR
     log line and a `mail` field on a document that already exists.
   ========================================================================== */

/* `.value()` on an unbound param can throw rather than return empty — outside
   a deployed function there is no secret to bind — so every read goes through
   here and falls back to the environment. A key that cannot be read is "off",
   never an exception. */
function secret(param, name) {
  try {
    const v = param.value();
    if (v) return String(v).trim();
  } catch (err) { /* fall through */ }
  return String(process.env[name] || "").trim();
}

function mailKey() {
  return secret(RESEND_API_KEY, "RESEND_API_KEY");
}

/* The secret always exists — a v2 function that declares one will not deploy
   without it — and it ships holding `disabled-see-SUPPORT-EMAIL.md`. Anything
   not shaped like a Resend key is read as "off", and off means the alert is
   archived, the log says so, and nothing throws. */
function mailOn(key) {
  return /^re_[A-Za-z0-9_-]{16,}$/.test(key);
}

/* Forced onto one line before it can go anywhere near an email. In practice
   the only outside string here is an address Firebase Auth already validated,
   but the builder should not be the place that depends on somebody else
   having checked. */
function oneLine(v, max) {
  return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").slice(0, max || 200);
}

function alertMail(subject, text) {
  return {
    from: MAIL_FROM,
    to: [ALERT_TO],                 /* CONSTANT. Never computed, never from a read. */
    subject: subject,
    text: text
  };
}

async function sendMail(key, id, subject, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MAIL_TIMEOUT_MS);
  try {
    const r = await fetch(MAIL_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        /* So a retry anywhere in the stack cannot mail the same alert twice.
           The alert id is unique by construction. */
        "Idempotency-Key": id
      },
      body: JSON.stringify(alertMail(subject, text))
    });
    if (r.status >= 200 && r.status < 300) return "";
    const detail = await r.text().catch(() => "");
    return "http_" + r.status + " " + detail.replace(/\s+/g, " ").slice(0, 200);
  } catch (err) {
    return (err && err.name === "AbortError") ? "timeout" : ("failed: " + (err && err.message));
  } finally {
    clearTimeout(timer);
  }
}

/* --- Raise one alert ----------------------------------------------------

   STORE FIRST, MAIL SECOND. The document is written before the mail is
   attempted and is written whether or not the mail can go, which is what
   makes an alert raised today recoverable when the key lands next week. The
   document holds the exact subject and body that would have been sent, so
   "what did I miss" is a question the archive answers rather than one that
   needs the event stream re-read.

   It returns nothing and throws nothing. A caller has already marked the
   per-day cap by the time this runs — deliberately, so that a mail provider
   failing cannot turn into a second attempt and then a third. */
async function raise(signal, subject, text, extra) {
  const when = new Date();
  const id = docId(when);
  const key = mailKey();
  const on = mailOn(key);

  const doc = Object.assign({
    signal: signal,
    at: admin.firestore.Timestamp.fromDate(when),
    day: utcDay(when),
    to: ALERT_TO,
    subject: subject,
    text: text,
    mail: on ? "pending" : "off"
  }, extra || {});

  try {
    await db.collection(COLLECTION).doc(id).set(doc);
  } catch (err) {
    /* The archive is the thing that must not fail. If it did, say so loudly
       and do not send: an email about an event with no record behind it is
       the one combination with nothing to check it against. */
    logger.error("alerts: could not archive the alert, not mailing", {
      signal: signal, message: err && err.message
    });
    return;
  }

  if (!on) {
    logger.warn("alerts: raised, mail is off", {
      signal: signal, id: id, subject: subject,
      why: key ? "key is not a Resend key" : "no key",
      recover: "firestore " + COLLECTION + "/" + id
    });
    return;
  }

  const why = await sendMail(key, id, subject, text);
  try {
    await db.collection(COLLECTION).doc(id).set({
      mail: why ? "failed" : "sent",
      mailWhy: why || null,
      mailedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    logger.error("alerts: could not record the mail result", { id: id, message: err && err.message });
  }

  if (why) logger.error("alerts mail failed", { signal: signal, id: id, reason: why });
  else logger.info("alerts mail sent", { signal: signal, id: id });
}

/* ==========================================================================
   ALERTS 1 AND 2 — the scheduled check

   ONE QUERY, one row per person, over TODAY so far. Two things come out of
   it and they answer two different questions:

     • "Is anything NEW?" — is there a qualifying event strictly newer than
       the watermark. This decides whether an alert fires at all, and it is
       what makes a second check five minutes later silent.
     • "How many, and how far?" — today's totals across every row. This is
       what the mail says, because "somebody arrived" is the news and "three
       people, one of them got to card 9" is the useful version of it.

   Querying the whole day rather than only the new window costs the same at
   this volume — the site has had zero /firststory opens in thirty hours — and
   means the mail can say "3 people today" rather than "1 person in the last
   fifteen minutes", which is the number a human actually wants at 8am.
   ========================================================================== */

function watchSql(dayStart, cutoff, admins) {
  /* notAdmins() is insights.js's own clause builder and it takes the same
     params object the dashboard passes it. Each uid goes through lit() inside
     it, re-asserting the character set at the point of placement. */
  const clause = notAdmins({ excludeAdmins: true, adminUids: admins });
  if (!clause) {
    /* Cannot happen — adminList() already refused an empty list — but an
       empty exclusion clause is exactly the silent failure this whole file is
       built against, so it is asserted rather than assumed. */
    const e = new Error("admin_clause_empty");
    e.code = "admin_clause_empty";
    throw e;
  }

  const fs = lit(FIRSTSTORY_PAGE);
  const st = lit(FIRSTSTORY_STACK);
  const lg = lit(LOGIN_PAGE);
  const jn = lit(JOIN_PAGE);

  return "SELECT" +
    " person_id AS person," +
    " countIf(event = 'page_open' AND toString(properties.page) = " + fs + ") AS arrivals," +
    " countIf(event = 'card_view' AND toString(properties.page) = " + fs + ") AS cards," +
    " max(if(event = 'card_view' AND toString(properties.page) = " + fs + "," +
    "   toInt(toString(properties.card)), NULL)) AS furthest," +
    " countIf(event = 'stack_complete' AND toString(properties.stack) = " + st + ") AS finished," +
    " countIf(event = 'page_open' AND toString(properties.page) = " + lg + ") AS login_hits," +
    " countIf(event = 'page_open' AND toString(properties.page) = " + jn + ") AS join_hits," +
    /* toString of a DateTime is 'YYYY-MM-DD hh:mm:ss', which compares against
       a watermark as a plain string. A person with none of these events gets
       ClickHouse's zero date back, which is older than every watermark. */
    " toString(maxIf(timestamp, event = 'page_open'" +
    "   AND toString(properties.page) = " + fs + ")) AS last_arrival," +
    " toString(maxIf(timestamp, event = 'page_open'" +
    "   AND toString(properties.page) IN (" + lg + ", " + jn + "))) AS last_login" +
    " FROM events" +
    " WHERE timestamp >= toDateTime(" + lit(dayStart) + ")" +
    "   AND timestamp <  toDateTime(" + lit(cutoff) + ")" +
    /* Narrow, so ClickHouse scans three event names rather than everything.
       No new event names anywhere in here: page_open, card_view and
       stack_complete are what js/analytics.js already sends. */
    "   AND ((event = 'page_open' AND toString(properties.page)" +
    "         IN (" + fs + ", " + lg + ", " + jn + "))" +
    "     OR (event = 'card_view' AND toString(properties.page) = " + fs + ")" +
    "     OR (event = 'stack_complete' AND toString(properties.stack) = " + st + "))" +
    clause +
    " GROUP BY person" +
    " ORDER BY arrivals DESC" +
    " LIMIT " + String(MAX_PERSON_ROWS);
}

const WATCH_COLUMNS = ["person", "arrivals", "cards", "furthest", "finished",
                       "login_hits", "join_hits", "last_arrival", "last_login"];

/* One POST, one query this file wrote, a hard timeout inside the function's
   own, and a ceiling on the response. Nothing from anywhere else reaches the
   URL, the headers or the body. */
async function ask(sql, key, projectId) {
  const url = PH_HOST + "/api/projects/" + encodeURIComponent(projectId) + "/query/";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } })
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error((err && err.name === "AbortError") ? "timeout" : "unreachable");
  }
  clearTimeout(timer);

  const text = await res.text();
  if (text.length > MAX_UPSTREAM_BYTES) throw new Error("too_large");
  if (!res.ok) {
    /* The upstream body can quote the query and, on an auth failure, say
       something about the key. Truncated, to the log, and nowhere else. */
    logger.error("alerts: posthog refused", { status: res.status, detail: text.slice(0, 300) });
    throw new Error("status_" + res.status);
  }
  let body;
  try { body = JSON.parse(text); } catch (err) { throw new Error("unparseable"); }

  const out = [];
  const results = (body && Array.isArray(body.results)) ? body.results : [];
  for (const r of results) {
    const row = {};
    if (Array.isArray(r)) {
      for (let i = 0; i < WATCH_COLUMNS.length; i++) row[WATCH_COLUMNS[i]] = r[i];
    } else if (r && typeof r === "object") {
      for (const c of WATCH_COLUMNS) row[c] = r[c];
    } else continue;
    out.push(row);
  }
  return out;
}

function n(v) {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}
function ts(v) {
  const s = String(v == null ? "" : v);
  /* ClickHouse's zero date means "this person did none of these". */
  return s.slice(0, 4) === "1970" ? "" : stamp(s);
}

/* Rows -> the two things the mail needs. `people` counts PEOPLE, not events:
   one person reloading /firststory eleven times is one arrival, which is the
   difference between an alarm and a noise generator. */
function fold(rows, state) {
  /* Normalised on the way in as well, so a watermark written before the width
     was fixed still compares correctly rather than re-reporting a day. */
  const throughArrival = stamp(state.arrivalThrough);
  const throughLogin = stamp(state.loginThrough);

  const out = {
    arrival: { people: 0, fresh: 0, furthest: 0, finished: 0, cards: 0, latest: "" },
    login:   { people: 0, fresh: 0, login: 0, join: 0, latest: "" },
    truncated: rows.length >= MAX_PERSON_ROWS
  };

  for (const r of rows) {
    const arrivals = n(r.arrivals);
    const cards = n(r.cards);
    const lastArrival = ts(r.last_arrival);
    const lastLogin = ts(r.last_login);

    /* "Arrived" is opening the page OR reading a card on it. A card view
       without a page_open happens — an in-app browser restoring a tab, an
       event lost on the way out — and somebody reading a card on /firststory
       unquestionably arrived there. */
    if (arrivals > 0 || cards > 0) {
      out.arrival.people++;
      out.arrival.cards += cards;
      const f = n(r.furthest);
      if (f > out.arrival.furthest) out.arrival.furthest = f;
      if (n(r.finished) > 0) out.arrival.finished++;
      if (lastArrival > out.arrival.latest) out.arrival.latest = lastArrival;
      if (lastArrival && lastArrival > throughArrival) out.arrival.fresh++;
    }

    const lg = n(r.login_hits), jn = n(r.join_hits);
    if (lg > 0 || jn > 0) {
      out.login.people++;
      out.login.login += lg;
      out.login.join += jn;
      if (lastLogin > out.login.latest) out.login.latest = lastLogin;
      if (lastLogin && lastLogin > throughLogin) out.login.fresh++;
    }
  }
  return out;
}

/* --- The mails ----------------------------------------------------------
   Short enough to read on a lock screen without opening it. What happened,
   how many people, when, and — for the arrival — how far they got, because
   "somebody arrived and read one card" and "somebody arrived and finished the
   story" are very different mornings.

   The last two lines of each are the honest ones, and they are in every mail
   rather than in a document nobody will reread at 8am: what was excluded, and
   what could not be. */
function excludedLines(adminCount) {
  return [
    "",
    "Left out: " + adminCount + " admin account" + (adminCount === 1 ? "" : "s") +
      ", by uid, once signed in.",
    "A signed-out browser of your own still looks like a stranger — nothing in",
    "the event stream separates the two. ALERTS.md, \"what this cannot tell\"."
  ];
}

function arrivalMail(f, adminCount) {
  const p = f.arrival.people;
  const subject = "Factbox — " +
    (p === 1 ? "someone opened /firststory" : p + " people opened /firststory");

  const lines = [
    p === 1 ? "Somebody opened /firststory." : p + " people opened /firststory.",
    "",
    "People today   : " + p,
    "New this check : " + f.arrival.fresh,
    "Furthest card  : " + (f.arrival.furthest > 0 ? f.arrival.furthest : "none read yet"),
    "Finished it    : " + f.arrival.finished + " of " + p,
    "Latest         : " + (f.arrival.latest || "unknown") + " UTC",
    "",
    "One of these a day. However many more arrive today, the next /firststory",
    "alert is tomorrow — the count above is today so far."
  ];
  if (f.truncated) lines.push("", "(Capped at " + MAX_PERSON_ROWS + " people; there were more.)");
  return { subject: subject, text: lines.concat(excludedLines(adminCount)).join("\n") };
}

function loginMail(f, adminCount) {
  const p = f.login.people;
  const subject = "Factbox — " +
    (p === 1 ? "someone reached the login page" : p + " people reached the login page");

  const lines = [
    p === 1 ? "Somebody reached the login page." : p + " people reached the login page.",
    "",
    "People today   : " + p,
    "New this check : " + f.login.fresh,
    "/login opens   : " + f.login.login,
    "/join opens    : " + f.login.join,
    "Latest         : " + (f.login.latest || "unknown") + " UTC",
    "",
    "Both doors are counted: /login, and the sign-up pane inside /join, which",
    "is where the end card of /firststory sends people.",
    "",
    "One of these a day. The count above is today so far."
  ];
  return { subject: subject, text: lines.concat(excludedLines(adminCount)).join("\n") };
}

/* ==========================================================================
   THE SCHEDULED FUNCTION

   Every fifteen minutes. Not every minute, because this is an alarm for a
   morning rather than a trading system, and 96 runs a day is inside every
   free tier while 1,440 starts to matter. Not every hour, because "the moment
   it starts working" should not mean "up to an hour after".

   maxInstances: 1 so two runs cannot overlap on the watermark. retryCount: 0
   so a failed run is one log line and the next run fifteen minutes later,
   never a retry loop against a mail provider or PostHog.

   IT NEVER THROWS. A scheduled function that throws is a failed job in a
   console nobody is watching; every failure here is a log line with a reason
   in it, and the watermark simply does not advance.
   ========================================================================== */

async function runCheck(now) {
  const cutoff = wholeSecond(new Date(now.getTime() - LAG_MS));
  const day = utcDay(cutoff);
  const cutoffStr = chTime(cutoff);              /* into the query, second width */
  const mark = stamp(cutoffStr);                 /* into the watermark, 26 chars */
  const dayStart = dayStartOf(cutoff);

  /* The admin list first, and before anything is spent. If the exclusion
     cannot be applied there is nothing worth asking PostHog. */
  const admins = await adminList();
  if (!admins) {
    logger.error("alerts: check skipped, admins cannot be excluded", { day: day });
    return { ok: false, why: "admin_list" };
  }

  const key = secret(POSTHOG_API_KEY, "POSTHOG_API_KEY");
  const project = secret(POSTHOG_PROJECT_ID, "POSTHOG_PROJECT_ID");
  if (!key || !project) {
    logger.error("alerts: posthog is not configured, check skipped");
    return { ok: false, why: "not_configured" };
  }

  /* Claim the upstream slot before spending it, so a run that dies mid-query
     has still paid for it and the daily cap cannot be walked past by
     crashing. */
  const claim = await db.runTransaction(async (tx) => {
    const ref = db.doc(STATE_DOC);
    const snap = await tx.get(ref);
    const s = rollDay(snap.exists ? snap.data() : null, day);
    if (s.upstream >= MAX_UPSTREAM_PER_DAY) return { allow: false, state: s };
    s.checks++;
    s.upstream++;
    tx.set(ref, Object.assign({}, s, {
      lastCheckAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }), { merge: true });
    return { allow: true, state: s };
  });

  if (!claim.allow) {
    logger.warn("alerts: daily upstream cap reached, not querying", {
      day: day, cap: MAX_UPSTREAM_PER_DAY
    });
    return { ok: false, why: "upstream_cap" };
  }

  let rows;
  try {
    rows = await ask(watchSql(dayStart, cutoffStr, admins), key, project);
  } catch (err) {
    /* The watermark deliberately does NOT advance. Whatever happened in this
       window is still ahead of it and will be seen in fifteen minutes. */
    logger.error("alerts: posthog query failed, watermark not advanced", {
      reason: err && err.message
    });
    return { ok: false, why: "upstream" };
  }

  const folded = fold(rows, claim.state);

  /* Decide and mark in ONE transaction, re-reading the state rather than
     trusting the copy from the claim above. Marking `sent` before the mail is
     attempted is the same rule support.js states: a mail failure must not
     become a second attempt, and the alert's text is already going to
     Firestore either way. */
  const decision = await db.runTransaction(async (tx) => {
    const ref = db.doc(STATE_DOC);
    const snap = await tx.get(ref);
    const s = rollDay(snap.exists ? snap.data() : null, day);
    const fire = [];

    for (const sig of [ARRIVAL, LOGIN]) {
      const f = folded[sig];
      s.seen[sig] = f.people;
      if (f.fresh > 0 && !s.sent[sig] && s.mailed < MAX_MAIL_PER_DAY) {
        fire.push(sig);
        s.sent[sig] = admin.firestore.Timestamp.fromDate(now);
        s.mailed++;
      }
    }

    /* Advanced whether or not anything was mailed. It means "PostHog has been
       read up to here", not "everything up to here has been emailed" — the
       once-a-day cap is a separate fact, in `sent` above. */
    s.arrivalThrough = mark;
    s.loginThrough = mark;

    tx.set(ref, Object.assign({}, s, {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }), { merge: true });
    return { fire: fire, state: s };
  });

  for (const sig of decision.fire) {
    const m = sig === ARRIVAL ? arrivalMail(folded, admins.length)
                              : loginMail(folded, admins.length);
    await raise(sig, m.subject, m.text, {
      people: folded[sig].people,
      fresh: folded[sig].fresh,
      window: { from: dayStart, to: cutoffStr },
      adminsExcluded: admins.length
    });
  }

  logger.info("alerts check", {
    day: day, through: cutoffStr, rows: rows.length,
    arrivals: folded.arrival.people, logins: folded.login.people,
    fired: decision.fire, mailedToday: decision.state.mailed
  });
  return { ok: true, fired: decision.fire, folded: folded };
}

exports.alertsWatch = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Etc/UTC",
    region: "us-central1",
    secrets: [POSTHOG_API_KEY, POSTHOG_PROJECT_ID, RESEND_API_KEY],
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 1,
    retryCount: 0
  },
  async () => {
    try {
      await runCheck(new Date());
    } catch (err) {
      /* Caught here so the job never goes red for a reason the log does not
         already carry, and never retries. */
      logger.error("alerts: check threw", { message: err && err.message });
    }
  }
);

/* ==========================================================================
   ALERT 3 — an account was created

   The exact one. Firebase Auth fires this the moment the account exists;
   there is no polling, no watermark and no analytics anywhere in it, so it
   cannot be lost to an ad blocker or a closed tab and it cannot be double
   counted. It is also the alert the owner most wants, which is a good reason
   for it to be the one with no moving parts.

   BACKGROUND, NOT BLOCKING. See the top of this file: a blocking trigger that
   throws would stop somebody joining the site.

   THE FALSE POSITIVE HERE IS DIFFERENT. A new account is never already an
   admin, so the uid list cannot catch the owner making one more test account.
   The address can, and does — see ownEmails(). If the address matches an
   admin's, or ALERT_TO, the alert is recorded as suppressed and no mail goes.
   Recorded rather than dropped, so "did it see that?" has an answer.
   ========================================================================== */

async function runSignup(user, now) {
  const uid = String((user && user.uid) || "");
  const address = String((user && user.email) || "");
  const provider = (user && user.providerData && user.providerData[0] &&
                    user.providerData[0].providerId) || "unknown";
  const day = utcDay(now);

  const admins = await adminList();
  if (!admins) {
    /* Fails closed for the same reason as the other two, and the record is
       still written so the account is not lost from the archive. */
    await archiveOnly(SIGNUP, day, {
      uid: uid, email: address, provider: provider,
      suppressed: "admin_list_unavailable"
    });
    return { ok: false, why: "admin_list" };
  }

  const own = await ownEmails(admins);
  if (!own) {
    await archiveOnly(SIGNUP, day, {
      uid: uid, email: address, provider: provider,
      suppressed: "admin_emails_unavailable"
    });
    return { ok: false, why: "admin_emails" };
  }

  /* The uid check as well, cheap and complete: an account cannot be an admin
     the instant it is made, but nothing stops this trigger being replayed for
     one that has since become one. */
  if (admins.indexOf(uid) !== -1 || own[normEmail(address)]) {
    logger.info("alerts: an account was created by one of us, not alerting", {
      uid: uid, provider: provider
    });
    await archiveOnly(SIGNUP, day, {
      uid: uid, email: address, provider: provider, suppressed: "own_account"
    });
    return { ok: true, suppressed: true };
  }

  const decision = await db.runTransaction(async (tx) => {
    const ref = db.doc(STATE_DOC);
    const snap = await tx.get(ref);
    const s = rollDay(snap.exists ? snap.data() : null, day);
    s.seen.signup++;
    const fire = !s.sent.signup && s.mailed < MAX_MAIL_PER_DAY;
    if (fire) {
      s.sent.signup = admin.firestore.Timestamp.fromDate(now);
      s.mailed++;
    }
    tx.set(ref, Object.assign({}, s, {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }), { merge: true });
    return { fire: fire, count: s.seen.signup };
  });

  if (!decision.fire) {
    logger.info("alerts: account created, already alerted today", {
      uid: uid, today: decision.count
    });
    await archiveOnly(SIGNUP, day, {
      uid: uid, email: address, provider: provider,
      suppressed: "already_alerted_today", todayCount: decision.count
    });
    return { ok: true, capped: true };
  }

  const m = signupMail(address, provider, uid, now, decision.count, admins.length);
  await raise(SIGNUP, m.subject, m.text, {
    uid: uid, email: address, provider: provider,
    todayCount: decision.count, adminsExcluded: admins.length
  });
  return { ok: true, fired: true };
}

/* An alert that was seen and deliberately not mailed. Same collection, so
   there is one place to look, with `suppressed` saying which and why. */
async function archiveOnly(signal, day, extra) {
  const when = new Date();
  try {
    await db.collection(COLLECTION).doc(docId(when)).set(Object.assign({
      signal: signal,
      at: admin.firestore.Timestamp.fromDate(when),
      day: day,
      mail: "suppressed"
    }, extra || {}));
  } catch (err) {
    logger.error("alerts: could not archive a suppressed alert", {
      signal: signal, message: err && err.message
    });
  }
}

/* The address is in the BODY and never in the subject, on one line, because
   it is the only string in any of these mails that this server did not
   generate. It is included in full and not masked on purpose: it is the one
   field that tells "a stranger joined" from "Kathryn made another test
   account", which is the entire question this alert exists to answer. It is
   the owner's own site, mailed to the owner's own address, and the same value
   is already on screen in the Firebase Auth console. ALERTS.md notes what
   privacy.html should say about it. */
function signupMail(address, provider, uid, when, todayCount, adminCount) {
  const lines = [
    "Somebody created a Factbox account.",
    "",
    "Email    : " + (oneLine(address, 200) || "none on the account"),
    "Provider : " + oneLine(provider, 40),
    "Account  : " + oneLine(uid, 128),
    "When     : " + chTime(when) + " UTC",
    "Today    : account number " + todayCount,
    "",
    "Not one of the " + adminCount + " admin account" + (adminCount === 1 ? "" : "s") +
      ", and not " + ALERT_TO + ".",
    "",
    "One of these a day. If more accounts are made today they are counted in",
    "alerts_meta/state and not mailed."
  ];
  return { subject: "Factbox — someone created an account", text: lines.join("\n") };
}

exports.alertsNewAccount = functionsV1
  .region("us-central1")
  .runWith({
    secrets: [RESEND_API_KEY],
    memory: "256MB",
    timeoutSeconds: 30,
    maxInstances: 3
  })
  .auth.user()
  .onCreate(async (user) => {
    try {
      await runSignup(user, new Date());
    } catch (err) {
      /* Never rethrown. This is a background trigger and it must not turn a
         successful sign-up into anything a reader can feel. */
      logger.error("alerts: signup handler threw", { message: err && err.message });
    }
  });

/* --- Exported for a test, and for nothing else --------------------------
   `functions/index.js` takes `.alertsWatch` and `.alertsNewAccount` and
   nothing else, so none of the below is deployed or reachable. These are the
   parts worth pointing a check script at without a key, a network or real
   traffic: the two mail builders, the folder that turns rows into counts, the
   query builder, the day-roll, and the address normaliser that is the whole
   signup filter. */
exports._arrivalMail = arrivalMail;
exports._loginMail = loginMail;
exports._signupMail = signupMail;
exports._fold = fold;
exports._watchSql = watchSql;
exports._rollDay = rollDay;
exports._normEmail = normEmail;
exports._stamp = stamp;
exports._ts = ts;
exports._mailOn = mailOn;
exports._alertMail = alertMail;
exports._runCheck = runCheck;
exports._runSignup = runSignup;
exports._ALERT_TO = ALERT_TO;
exports._STATE_DOC = STATE_DOC;
exports._COLLECTION = COLLECTION;
exports._MAX_MAIL_PER_DAY = MAX_MAIL_PER_DAY;
exports._MAX_UPSTREAM_PER_DAY = MAX_UPSTREAM_PER_DAY;
