/* ==========================================================================
   Factbox — /admin/dashboard

   READ THIS BEFORE TRUSTING THE GATE AT THE TOP OF IT.

   This file decides what to DRAW. It does not decide who may see a number,
   it cannot, and nothing in it is written as though it could. factbox-site
   is a public repo served as static files: everything below is delivered to
   every browser that asks, `FBU.admin()` is a boolean read out of the
   reader's own customer document, and a boolean in a browser is a boolean
   anyone can set. Assume a stranger opens /admin/dashboard, reads this file,
   and flips every flag in it. What they get is the layout.

   What they do not get is data, because there is no data in this file and no
   route to any. Every figure on the page comes back from one POST to the
   `insights` function, which is handed a Firebase ID token and verifies the
   admin claim server-side on every single request. If that function answers
   `not_admin` this page throws away whatever it had drawn and shows the
   refusal — see deny() — so the two checks fail closed in the same
   direction and the server's is the one that counts.

   The contract is ANALYTICS-API.md. Eleven named queries, a typed `params`
   object, and four error codes that do not grow. Nothing here sends a query
   language, a column name or a sort order; `params` contributes values only.

   ES5 ONLY. This site is read inside the Instagram and TikTok webviews and
   the rule is uniform: var, function, no arrow, no template literal, no
   let/const, no spread, no class. js/auth.js is the single exception and
   this file only calls it.

   NO ANALYTICS. js/analytics.js is not loaded by admin/dashboard.html and
   this file sends nothing, on purpose. That script fires page_open on load
   and a ui_click for every tap on any control; on this page that would put
   every column sort and every range change into the very counts the page is
   reporting — and straight into button_presses, which is a table this page
   draws. A dashboard that measures its own use answers a different question
   every time you look at it. No event name in this repo is new because of
   this page.
   ========================================================================== */

(function () {
  "use strict";

  /* Same project and host as /today and /support, the two functions this site
     already calls from the browser. The endpoint checks admin itself, so this
     constant being public costs nothing. */
  var API = "https://us-central1-factbox-7cb97.cloudfunctions.net/insights";

  /* The story catalogue, for turning "26" into the story's name. A public
     file the shelf already fetches on every visit, holding no numbers. It is
     NOT the analytics source — it is a lookup table. */
  var INDEX = "/data/index.json";

  var REQ_MS = 25000;

  /* The allowlist `event_volume` validates against, held in
     functions/insights.js as KNOWN_EVENTS. There is no query that returns
     it, so it is copied — and a name that has drifted out of it comes back
     as bad_query, which this page renders as a sentence rather than a crash.
     WHEN js/analytics.js GAINS AN EVENT: add it there first, then here. */
  var KNOWN_EVENTS = [
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
     Small DOM helpers
     ========================================================================== */

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function show(id) { var e = $(id); if (e) e.hidden = false; }
  function hide(id) { var e = $(id); if (e) e.hidden = true; }
  function setText(id, s) { var e = $(id); if (e) e.textContent = String(s); }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function has(o, k) {
    try { return Object.prototype.hasOwnProperty.call(o, k); } catch (e) { return false; }
  }

  function indexOf(a, v) {
    for (var i = 0; i < a.length; i++) { if (a[i] === v) return i; }
    return -1;
  }

  /* ==========================================================================
     The whenFBU bridge — AUTH.md §2, copied rather than imported

     js/auth.js is a module, so the browser defers it: it runs after the
     document is parsed and BEFORE DOMContentLoaded. This file is a classic
     script and runs at its own tag, when window.FBU does not exist yet. cb
     gets null when FBU is genuinely absent — a 404, a browser that ignores
     type="module", a parse error — and that is a state this page renders
     rather than hides behind.
     ========================================================================== */

  function whenFBU(cb) {
    var done = false;
    function go() { if (done) return; done = true; try { cb(window.FBU || null); } catch (e) {} }
    if (window.FBU) { go(); return; }
    try { window.addEventListener("fbu-ready", go, false); } catch (e) {}
    try {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, false);
      else setTimeout(go, 0);
    } catch (e) {}
    try { setTimeout(go, 4000); } catch (e) { go(); }
  }

  /* ==========================================================================
     The gate

     Exactly one panel is ever visible, and one always is. There is no path
     through this that leaves the page blank and none that leaves a spinner
     running: every branch ends on a panel with a sentence and a way out.
     ========================================================================== */

  var PANELS = ["dsh-p-wait", "dsh-p-noauth", "dsh-p-out", "dsh-p-no"];
  var FBU = null;
  var running = false;

  function panel(id) {
    for (var i = 0; i < PANELS.length; i++) {
      if (PANELS[i] === id) show(PANELS[i]); else hide(PANELS[i]);
    }
    show("dsh-gate");
    hide("dsh-main");
  }

  /* The server said no. Whatever this page had drawn is wrong, so it goes.
     This is the branch that matters: FBU.admin() being true and the function
     disagreeing is exactly the case the browser flag cannot be trusted for. */
  function deny() {
    running = false;
    GEN++;                                  /* abandon anything still queued */
    QUEUE.length = 0;
    panel("dsh-p-no");
    setText("dsh-no-say",
      "You are signed in, but the analytics service will not answer for this " +
      "account: it is not an admin. Nothing is missing and nothing is broken " +
      "— there is simply nothing here for this account.");
  }

  function boot(fbu) {
    FBU = fbu;

    if (!FBU) { panel("dsh-p-noauth"); return; }

    if (typeof FBU.unavailable === "function" && FBU.unavailable()) {
      panel("dsh-p-noauth");
      return;
    }

    /* Signing out with the page open sends it back to the gate rather than
       leaving a screen of numbers behind on a shared laptop. */
    try {
      if (typeof FBU.onChange === "function") {
        FBU.onChange(function (u) {
          if (!u && running) { running = false; GEN++; QUEUE.length = 0; panel("dsh-p-out"); }
        });
      }
    } catch (e) {}

    var btn = $("dsh-signout");
    if (btn) {
      btn.onclick = function () {
        try { if (typeof FBU.signOut === "function") FBU.signOut(); } catch (e) {}
        panel("dsh-p-out");
      };
    }

    FBU.onReady(function (u) {
      if (!u) { panel("dsh-p-out"); return; }

      setText("dsh-wait-say", "Signed in. Checking whether this account is an admin…");

      /* admin is written by the same Firestore snapshot that answers the
         premium question, so it is not known at ready() — it is known at
         billingReady(). Deciding before that shows every admin the refusal
         for a second and a half on every load. */
      var settled = false;
      function decide() {
        if (settled) return;
        settled = true;
        var isAdmin = false;
        try { isAdmin = typeof FBU.admin === "function" && FBU.admin() === true; } catch (e) {}
        if (!isAdmin) { panel("dsh-p-no"); return; }
        start();
      }

      try {
        var p = FBU.billingReady();
        if (p && typeof p.then === "function") p.then(decide, decide);
        else decide();
      } catch (e) { decide(); }

      /* billingReady() settles on its own clock, but a promise that never
         settles must not become a spinner that never stops. */
      try { setTimeout(decide, 9000); } catch (e) {}
    });
  }

  /* ==========================================================================
     The API, and the queue in front of it

     ANALYTICS-API.md §5: thirty requests a minute per admin, and the
     dashboard is asked to load its panels "sequentially or in small batches,
     not eleven at once every render". So two at a time, in order. A full
     render is at most eleven queries; two at a time is well inside the limit
     and still fills the page in a couple of seconds.

     GEN is the generation counter. Pressing Refresh while a render is still
     going abandons the rest of the old batch rather than letting two batches
     paint over each other in whatever order they answer.
     ========================================================================== */

  var QUEUE = [], INFLIGHT = 0, MAXP = 2, GEN = 0;

  function ask(name, params, done) {
    QUEUE.push({ name: name, params: params || {}, done: done, gen: GEN });
    pump();
  }

  function pump() {
    while (INFLIGHT < MAXP && QUEUE.length) {
      var job = QUEUE.shift();
      if (job.gen !== GEN) continue;        /* a newer render replaced it */
      INFLIGHT++;
      fire(job);
    }
  }

  function fire(job) {
    var settled = false;
    function finish(err, res, extra) {
      if (settled) return;
      settled = true;
      INFLIGHT--;
      if (job.gen === GEN) { try { job.done(err, res, extra || {}); } catch (e) {} }
      pump();
    }

    var u = null;
    try { u = FBU && typeof FBU.user === "function" ? FBU.user() : null; } catch (e) {}
    if (!u || typeof u.getIdToken !== "function") { finish("signed_out", null, {}); return; }

    /* Per request, not cached for the hour — getIdToken() refreshes a token
       that is close to expiring, and a dashboard left open all afternoon is
       exactly the case that needs it. */
    var tp = null;
    try { tp = u.getIdToken(); } catch (e) { tp = null; }
    if (!tp || typeof tp.then !== "function") { finish("no_token", null, {}); return; }

    tp.then(function (tok) { send(String(tok || "")); }, function () { finish("no_token", null, {}); });

    function send(tok) {
      if (!tok) { finish("no_token", null, {}); return; }

      var body;
      try { body = JSON.stringify({ query: job.name, params: job.params }); }
      catch (e) { finish("bad_query", null, {}); return; }

      var xhr;
      try { xhr = new XMLHttpRequest(); } catch (e) { finish("network", null, {}); return; }

      try {
        xhr.open("POST", API, true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", "Bearer " + tok);
        xhr.timeout = REQ_MS;
        xhr.ontimeout = function () { finish("network", null, {}); };
        xhr.onerror = function () { finish("network", null, {}); };
        xhr.onload = function () {
          var data = null;
          try { data = JSON.parse(xhr.responseText); } catch (e) {}

          /* A 401 or 403 with no readable body is still a refusal, and the
             refusal is the one that has to fail closed. */
          if (!data || typeof data !== "object") {
            finish(xhr.status === 401 || xhr.status === 403 ? "not_admin" : "network", null, {});
            return;
          }
          if (data.ok === true) { finish(null, data, {}); return; }
          /* Branch on `error` only — ANALYTICS-API.md §2. The advisory keys
             are read for the message and never for the decision. */
          finish(String(data.error || "upstream"), null, data);
        };
        xhr.send(body);
      } catch (e) { finish("network", null, {}); }
    }
  }

  function saysFor(err, extra) {
    extra = extra || {};
    if (err === "bad_query") {
      return "The analytics function refused this query (bad_query" +
             (extra.field ? ", field “" + extra.field + "”" : "") +
             "). That is a bug in this page, not something you did.";
    }
    if (err === "rate_limited") {
      return typeof extra.retry_after_s === "number"
        ? ("Too many requests. Wait about " + Math.ceil(extra.retry_after_s) +
           " seconds and press Refresh.")
        : "The request cap for today is spent. It resets tomorrow.";
    }
    if (err === "upstream") {
      if (extra.reason === "not_configured") {
        /* Short, because this lands in every section at once and the full
           explanation is written once at the top of the page instead. */
        return "Analytics is not connected yet — see the note under the dates.";
      }
      return "Analytics is unavailable — the source refused or timed out" +
             (extra.reason ? " (" + extra.reason + ")" : "") +
             ". Press Refresh in a few seconds; if it keeps happening it is upstream.";
    }
    if (err === "network") {
      return "We could not reach the analytics function. Check the connection and press Refresh.";
    }
    if (err === "no_token") {
      return "We could not prove who you are to the analytics function. Sign out and back in.";
    }
    if (err === "signed_out") return "You are not signed in any more.";
    return "The analytics function returned an error this page does not " +
           "recognise: " + String(err) + ".";
  }

  /* ==========================================================================
     Formatting

     Nothing here hard-codes a schema. The KEY NAME is read for a hint about
     what the value means — a _s suffix is seconds, a _pct is already a
     percentage — and anything unrecognised is printed as what it is. A column
     the function starts returning tomorrow appears tomorrow, labelled from
     its own name, without a line changing here.
     ========================================================================== */

  function kindOf(key) {
    var k = String(key).toLowerCase();
    if (/_ms$/.test(k)) return "ms";
    if (/_(secs|seconds|sec|s)$/.test(k)) return "sec";
    if (/(^|_)pct($|_)/.test(k) || /_percent$/.test(k)) return "pct";
    if (/_(rate|share|ratio|frac|fraction)$/.test(k)) return "frac";
    return "";
  }

  function fmtInt(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    var neg = n < 0, s = String(Math.round(Math.abs(n))), out = "", i;
    for (i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ",";
      out += s.charAt(i);
    }
    return (neg ? "−" : "") + out;
  }

  function fmtNum(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    if (n === Math.round(n)) return fmtInt(n);
    return String(Math.round(n * 100) / 100);
  }

  /* Durations read as durations. 0.9s, 47s, 2m 04s, 1h 12m — never 74000. */
  function fmtMs(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "—";
    var s = ms / 1000;
    if (s < 10) return (Math.round(s * 10) / 10) + "s";
    if (s < 60) return Math.round(s) + "s";
    var m = Math.floor(s / 60), r = Math.round(s - m * 60);
    if (r === 60) { m = m + 1; r = 0; }
    if (m < 60) return m + "m " + (r < 10 ? "0" : "") + r + "s";
    var h = Math.floor(m / 60);
    m = m - h * 60;
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
  }

  /* A proportion may arrive either way round, and guessing silently is how a
     91% completion rate gets reported as 0.9%. The rule, written down: a
     _pct is ALWAYS already a percentage — which is what every percentage
     column in ANALYTICS-API.md is — and a _rate / _share between 0 and 1 is
     a fraction of one. */
  function fmtPct(v, kind) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    var p = kind === "pct" ? v : (v > 1 || v < -1 ? v : v * 100);
    return (Math.round(p * 10) / 10) + "%";
  }

  /* 0..1 for the bar behind a cell, or -1 for "not a proportion". */
  function fracOf(v, kind) {
    if (typeof v !== "number" || !isFinite(v)) return -1;
    var p = kind === "pct" ? v / 100 : (v > 1 ? v / 100 : v);
    if (p < 0) return 0;
    if (p > 1) return 1;
    return p;
  }

  function fmtCell(key, v) {
    if (v === null || v === undefined || v === "") return "—";
    var kind = kindOf(key);
    if (typeof v === "number") {
      if (kind === "ms") return fmtMs(v);
      if (kind === "sec") return fmtMs(v * 1000);
      if (kind === "frac" || kind === "pct") return fmtPct(v, kind);
      return fmtNum(v);
    }
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch (e) { return "—"; }
    }
    return String(v);
  }

  var LABELS = {
    story: "Story", title: "Story", label: "Step", step: "Step id",
    card: "Card", last_card: "Last card", median_last_card: "They stop on",
    opens: "Opens", completions: "Finished", completion_pct: "Finish rate",
    readers: "Readers", median_dwell_s: "Median dwell", median_cards: "Median cards",
    views: "Views", reach_pct: "Still here", dropoff_pct: "Lost on this card",
    stopped: "Stopped here", completed: "Finished", sessions: "Sessions",
    share_pct: "Share", people: "People", events: "Events",
    pct_of_first: "Of the first step", pct_of_previous: "Of the step before",
    why: "Why", plan: "Plan", blocks: "Blocks",
    kind: "Kind", finished: "Finished the flow",
    control: "Button", presses: "Presses", page: "Page",
    day: "Day", metric: "Metric", value: "Value",
    message: "Message", source: "File", line: "Line", release: "Release",
    errors: "Errors", last_seen: "Last seen"
  };

  function labelOf(key, over) {
    if (over && has(over, key)) return over[key];
    if (has(LABELS, key)) return LABELS[key];
    var s = String(key).replace(/_(ms|secs|seconds|sec|s|rate|pct|percent|share|ratio|frac|fraction)$/, "");
    s = s.replace(/_/g, " ").replace(/\s+/g, " ");
    s = s.replace(/^\s+|\s+$/g, "");
    if (!s) s = String(key);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* The first key in `list` that any row actually carries. This is how every
     section finds "the column that is the count" without being told, and how
     the page survives the function renaming one. */
  function pick(rows, list) {
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      for (var j = 0; j < rows.length; j++) {
        if (has(rows[j], list[i]) && rows[j][list[i]] !== null && rows[j][list[i]] !== undefined) {
          return list[i];
        }
      }
    }
    return null;
  }

  /* Preferred columns first, in the order asked for; then everything else the
     rows turned out to have, in the order it first appeared. Nothing the
     function returns is ever dropped — a column added upstream shows up here
     with no change to this file. */
  function columnsOf(rows, prefer, omit) {
    var seen = {}, order = [], i, k;
    for (i = 0; i < rows.length; i++) {
      for (k in rows[i]) {
        if (has(rows[i], k) && !has(seen, k)) { seen[k] = 1; order.push(k); }
      }
    }
    /* A column the row already shows somewhere else — the story id printed
       under its own title, say — is duplication rather than thoroughness, and
       two columns headed "Story" is worse than one. This is the ONLY way a
       column is ever dropped, and the caller has to name it. */
    if (omit) { for (i = 0; i < omit.length; i++) { if (omit[i]) delete seen[omit[i]]; } }
    var out = [], used = {};
    for (i = 0; i < prefer.length; i++) {
      if (prefer[i] && has(seen, prefer[i]) && !has(used, prefer[i])) {
        out.push(prefer[i]); used[prefer[i]] = 1;
      }
    }
    for (i = 0; i < order.length; i++) {
      if (has(seen, order[i]) && !has(used, order[i])) { out.push(order[i]); used[order[i]] = 1; }
    }
    return out;
  }

  /* ==========================================================================
     Story names

     story_performance and card_dropoff return a story ID. The name comes from
     the public catalogue the shelf already uses. If the catalogue does not
     load, the id is shown and nothing else changes.
     ========================================================================== */

  var NAMES = {};
  var namesReady = false;
  var namesWaiting = [];

  function storyName(id) {
    var k = String(id === null || id === undefined ? "" : id);
    if (has(NAMES, k)) return NAMES[k];
    /* "1" and "01" are the same story in a URL and in a spreadsheet. */
    if (/^\d$/.test(k) && has(NAMES, "0" + k)) return NAMES["0" + k];
    if (/^0\d$/.test(k) && has(NAMES, k.slice(1))) return NAMES[k.slice(1)];
    return "";
  }

  function onNames(fn) {
    if (namesReady) { try { fn(); } catch (e) {} return; }
    namesWaiting.push(fn);
  }

  function loadNames() {
    function settle() {
      if (namesReady) return;
      namesReady = true;
      var q = namesWaiting;
      namesWaiting = [];
      for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
    }
    try {
      if (typeof window.fetch !== "function") { settle(); return; }
      window.fetch(INDEX, { credentials: "omit" }).then(function (r) {
        return r && r.ok ? r.json() : null;
      }).then(function (d) {
        try {
          var list = d && d.stacks ? d.stacks : [];
          for (var i = 0; i < list.length; i++) {
            var s = list[i];
            if (s && s.id) NAMES[String(s.id)] = String(s.title || s.id);
          }
        } catch (e) {}
        settle();
      }, function () { settle(); });
      /* A catalogue that never answers must not hold the page. */
      setTimeout(settle, 6000);
    } catch (e) { settle(); }
  }

  /* ==========================================================================
     Tables

     Sortable, and sorted by clicking a real <button> inside the <th> so it is
     reachable from a keyboard. The th carries aria-sort, so a screen reader
     is told the order once instead of reading a caret.
     ========================================================================== */

  var TABLES = {};

  function cmpVals(a, b) {
    var na = typeof a === "number" && isFinite(a);
    var nb = typeof b === "number" && isFinite(b);
    if (na && nb) return a - b;
    if (na) return 1;
    if (nb) return -1;
    if (a === null || a === undefined) return (b === null || b === undefined) ? 0 : -1;
    if (b === null || b === undefined) return 1;
    var sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }

  function isNumericCol(rows, key) {
    var seen = false;
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i][key];
      if (v === null || v === undefined || v === "") continue;
      if (typeof v !== "number") return false;
      seen = true;
    }
    return seen;
  }

  function drawTable(id, rows, opts) {
    var t = has(TABLES, id) ? TABLES[id] : (TABLES[id] = {});
    opts = opts || {};
    t.rows = rows || [];
    t.opts = opts;
    t.cols = columnsOf(t.rows, opts.prefer || [], opts.omit || null);
    if (t.sortKey && indexOf(t.cols, t.sortKey) < 0) t.sortKey = null;
    if (!t.sortKey) {
      t.sortKey = opts.sort && indexOf(t.cols, opts.sort) >= 0 ? opts.sort : null;
      t.sortDir = opts.dir === 1 ? 1 : -1;
    }
    paintTable(id);
  }

  function paintTable(id) {
    var el = $(id);
    var t = has(TABLES, id) ? TABLES[id] : null;
    if (!el || !t) return;

    var rows = t.rows.slice(0), cols = t.cols, opts = t.opts, i, j;

    if (t.sortKey) {
      var sk = t.sortKey, dir = t.sortDir;
      rows.sort(function (a, b) { return cmpVals(a[sk], b[sk]) * dir; });
    }

    var numeric = {}, frac = {};
    for (i = 0; i < cols.length; i++) {
      numeric[cols[i]] = isNumericCol(t.rows, cols[i]);
      var kind = kindOf(cols[i]);
      frac[cols[i]] = numeric[cols[i]] && (kind === "frac" || kind === "pct");
    }

    var nameCol = opts.nameCol && indexOf(cols, opts.nameCol) >= 0 ? opts.nameCol : null;

    var h = "<thead><tr>", c, sortAttr, caret;
    for (i = 0; i < cols.length; i++) {
      c = cols[i];
      sortAttr = t.sortKey === c
        ? (t.sortDir === 1 ? " aria-sort=\"ascending\"" : " aria-sort=\"descending\"") : "";
      caret = t.sortKey === c ? (t.sortDir === 1 ? "▲" : "▼") : "▼";
      h += "<th scope=\"col\"" + (numeric[c] && c !== nameCol ? " class=\"dsh-n\"" : "") + sortAttr + ">" +
           "<button type=\"button\" class=\"dsh-sort\" data-k=\"" + esc(c) + "\">" +
           "<span>" + esc(labelOf(c, opts.labels)) + "</span>" +
           "<span class=\"dsh-caret\" aria-hidden=\"true\">" + caret + "</span>" +
           "</button></th>";
    }
    h += "</tr></thead><tbody>";

    for (j = 0; j < rows.length; j++) {
      var r = rows[j];
      var mark = opts.markKey && opts.markVal !== undefined &&
                 String(r[opts.markKey]) === String(opts.markVal) ? " class=\"dsh-on\"" : "";
      h += "<tr" + mark + ">";
      for (i = 0; i < cols.length; i++) {
        var col = cols[i], val = r[col], txt = null;

        /* A metric/value table holds several units in one column, so the
           section that knows what they are may say. Everything else falls
           through to the key-name rule. */
        if (opts.cellFmt) { try { txt = opts.cellFmt(col, val, r); } catch (e) { txt = null; } }
        if (txt === null || txt === undefined) txt = fmtCell(col, val);

        if (col === nameCol) {
          var sub = opts.subKey && r[opts.subKey] !== undefined && r[opts.subKey] !== null
                    ? String(r[opts.subKey]) : "";
          h += "<td class=\"dsh-name\">" + esc(txt) +
               (sub ? " <span class=\"dsh-id\">" + esc(sub) + "</span>" : "") + "</td>";
        } else if (frac[col]) {
          var f = fracOf(val, kindOf(col));
          h += "<td class=\"dsh-n\"><span class=\"dsh-cell-bar\">" +
               (f >= 0 ? "<i style=\"width:" + Math.round(f * 100) + "%\"></i>" : "") +
               "<span>" + esc(txt) + "</span></span></td>";
        } else {
          h += "<td" + (numeric[col] ? " class=\"dsh-n\"" : "") + ">" + esc(txt) + "</td>";
        }
      }
      h += "</tr>";
    }
    h += "</tbody>";

    el.innerHTML = h;

    var btns = el.getElementsByTagName("button");
    for (i = 0; i < btns.length; i++) {
      (function (b) {
        b.onclick = function () {
          var key = b.getAttribute("data-k");
          if (t.sortKey === key) t.sortDir = t.sortDir === 1 ? -1 : 1;
          else { t.sortKey = key; t.sortDir = isNumericCol(t.rows, key) ? -1 : 1; }
          paintTable(id);
        };
      })(btns[i]);
    }
  }

  /* ==========================================================================
     Charts — a line, a bar and a funnel, drawn as inline SVG

     No CDN. This site loads no third-party JavaScript and is not going to
     start for a bar chart.

     Each is drawn at the PIXEL width of its container and redrawn when that
     changes, so nothing is ever scaled: 13px type is 13px type at 375 and at
     1920. Below MINW the container scrolls sideways inside its own box
     rather than shrinking the chart, because an SVG squeezed to a third of
     its width has 5px numbers on it and is a picture of some data instead of
     the data.

     And every chart's numbers are written on it as text, and again in the
     table underneath it. A chart nobody can read a value off is decoration.
     ========================================================================== */

  var MINW = 560, MAXW = 1240;
  var CHARTS = {}, DRAWN = {};

  function widthFor(id) {
    var el = $(id), w = 0;
    try { w = el && el.parentNode ? el.parentNode.clientWidth : 0; } catch (e) {}
    if (!w) w = 720;                 /* the box is display:none — see chart() */
    w = w - 4;
    if (w < MINW) w = MINW;
    if (w > MAXW) w = MAXW;
    return Math.round(w);
  }

  /* DM Sans at --fs-meta is about 6.7px a character at the default root size.
     Clipping on an estimate is wrong by a character either way and is the
     only option without measuring every string in the layout; the full value
     is always in the table below. */
  function clipTo(s, px) {
    s = String(s);
    var max = Math.max(4, Math.floor(px / 6.7));
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
  }

  function paintChart(id) {
    var el = $(id);
    if (!el || !has(CHARTS, id)) return;
    var w = widthFor(id);
    if (DRAWN[id] === w && el.firstChild) return;     /* nothing has moved */
    DRAWN[id] = w;
    try { el.innerHTML = CHARTS[id](w); } catch (e) { el.innerHTML = ""; }
  }

  /* Draw now, then measure again on the next turn of the event loop.

     A section draws its chart and THEN unhides the box it lives in, because
     the box stays hidden until there is something to put in it. At the moment
     of the first draw the container is still display:none and clientWidth is
     0, so every chart on this page rendered at the 720px fallback and sat in
     a 1244px box with a third of it empty. Rather than depend on eight call
     sites keeping the right order forever, the re-measure is here: by the
     time the timeout runs the box is visible and the real width is known.
     It also picks up a web font landing and any later reflow. */
  function chart(id, draw) {
    CHARTS[id] = draw;
    delete DRAWN[id];
    paintChart(id);
    try { setTimeout(function () { paintChart(id); }, 0); } catch (e) {}
  }

  function dropChart(id) {
    if (has(CHARTS, id)) { try { delete CHARTS[id]; } catch (e) {} }
    if (has(DRAWN, id)) { try { delete DRAWN[id]; } catch (e) {} }
    var el = $(id);
    if (el) el.innerHTML = "";
  }

  function redrawCharts() {
    for (var id in CHARTS) {
      if (!has(CHARTS, id)) continue;
      paintChart(id);
    }
  }

  var resizeAt = null;
  try {
    window.addEventListener("resize", function () {
      if (resizeAt) clearTimeout(resizeAt);
      resizeAt = setTimeout(redrawCharts, 140);
    }, false);
  } catch (e) {}

  function svgOpen(w, h, title) {
    return "<svg width=\"" + w + "\" height=\"" + h + "\" viewBox=\"0 0 " + w + " " + h +
           "\" role=\"img\" aria-label=\"" + esc(title) +
           " — the same figures are in the table below\">";
  }

  /* ---- Bars -------------------------------------------------------------
     items: [{ label, value, right }] — `right` is the string written at the
     end of the row, and it is what the reader actually reads. */
  function barsSVG(w, items, title) {
    if (!items.length) return "";
    var rowH = 30, gap = 4, top = 8, bot = 8, i;
    /* Fit the label column to the longest label rather than always taking
       30% — "Card 1" does not need 300px, and the bar is what carries the
       comparison. Still capped, because a story title can be a sentence. */
    var longest = 0;
    for (i = 0; i < items.length; i++) longest = Math.max(longest, String(items[i].label).length);
    var labW = Math.max(64, Math.min(Math.round(w * 0.30), Math.round(longest * 6.9) + 8));
    var valW = 0;
    for (i = 0; i < items.length; i++) valW = Math.max(valW, String(items[i].right).length * 7.4);
    valW = Math.max(56, Math.min(210, Math.round(valW) + 12));
    var x0 = labW + 12;
    var barW = w - x0 - valW - 8;
    if (barW < 60) barW = 60;

    var max = 0;
    for (i = 0; i < items.length; i++) if (items[i].value > max) max = items[i].value;
    if (max <= 0) max = 1;

    var h = top + items.length * (rowH + gap) - gap + bot;
    var s = svgOpen(w, h, title);

    for (i = 0; i < items.length; i++) {
      var y = top + i * (rowH + gap);
      var bh = 18, by = y + Math.round((rowH - bh) / 2);
      var fw = Math.max(2, Math.round(barW * (items[i].value / max)));
      s += "<rect class=\"dsh-track\" x=\"" + x0 + "\" y=\"" + by + "\" width=\"" + barW +
           "\" height=\"" + bh + "\" rx=\"4\"></rect>";
      s += "<rect class=\"dsh-fill\" x=\"" + (x0 + 0.5) + "\" y=\"" + (by + 0.5) + "\" width=\"" + fw +
           "\" height=\"" + (bh - 1) + "\" rx=\"3.5\"></rect>";
      s += "<text class=\"dsh-t\" x=\"0\" y=\"" + (y + 20) + "\">" +
           esc(clipTo(items[i].label, labW)) + "</text>";
      s += "<text class=\"dsh-t\" x=\"" + (x0 + barW + 8) + "\" y=\"" + (y + 20) + "\">" +
           esc(items[i].right) + "</text>";
    }
    return s + "</svg>";
  }

  /* ---- A line, or two ---------------------------------------------------
     pts: [{ x, a, b }]. `a` is the left axis, `b` the optional right one.
     Both axes are labelled with real numbers at both ends and in the middle;
     a line chart with an unlabelled axis says "it went down" and nothing
     more. */
  function lineSVG(w, pts, opt) {
    if (!pts.length) return "";
    var padL = 62, padR = opt.bLabel ? 66 : 16, padT = 16, padB = 34;
    var h = 260;
    var iw = w - padL - padR, ih = h - padT - padB, i;
    if (iw < 80) iw = 80;

    var maxA = 0, maxB = 0;
    for (i = 0; i < pts.length; i++) {
      if (typeof pts[i].a === "number" && pts[i].a > maxA) maxA = pts[i].a;
      if (typeof pts[i].b === "number" && pts[i].b > maxB) maxB = pts[i].b;
    }
    if (maxA <= 0) maxA = 1;
    if (maxB <= 0) maxB = 1;

    function px(k) { return padL + (pts.length === 1 ? iw / 2 : iw * k / (pts.length - 1)); }
    function pyA(v) { return padT + ih - ih * (v / maxA); }
    function pyB(v) { return padT + ih - ih * (v / maxB); }

    var s = svgOpen(w, h, opt.title || "Chart");

    /* Three gridlines, each with its value written on both axes, so a point
       can be read off rather than admired. */
    for (i = 0; i <= 2; i++) {
      var gy = padT + ih * i / 2;
      s += "<line class=\"dsh-rule\" x1=\"" + padL + "\" y1=\"" + gy + "\" x2=\"" + (padL + iw) +
           "\" y2=\"" + gy + "\"></line>";
      var av = maxA * (1 - i / 2);
      s += "<text class=\"dsh-t-dim\" x=\"" + (padL - 8) + "\" y=\"" + (gy + 4) +
           "\" text-anchor=\"end\">" + esc(opt.aFmt ? opt.aFmt(av) : fmtNum(av)) + "</text>";
      if (opt.bLabel) {
        var bv = maxB * (1 - i / 2);
        s += "<text class=\"dsh-t-dim\" x=\"" + (padL + iw + 8) + "\" y=\"" + (gy + 4) + "\">" +
             esc(opt.bFmt ? opt.bFmt(bv) : fmtNum(bv)) + "</text>";
      }
    }

    function path(key, yf) {
      var d = "", n = 0;
      for (var j = 0; j < pts.length; j++) {
        var v = pts[j][key];
        if (typeof v !== "number" || !isFinite(v)) continue;
        d += (n === 0 ? "M" : "L") + (Math.round(px(j) * 10) / 10) + " " +
             (Math.round(yf(v) * 10) / 10) + " ";
        n++;
      }
      return n > 1 ? d : "";
    }

    if (opt.bLabel) {
      var db = path("b", pyB);
      if (db) s += "<path class=\"dsh-line-2\" d=\"" + db + "\"></path>";
    }
    var da = path("a", pyA);
    if (da) s += "<path class=\"dsh-line\" d=\"" + da + "\"></path>";

    /* Dots only when they will not merge into a caterpillar. */
    if (pts.length <= 40) {
      for (i = 0; i < pts.length; i++) {
        if (typeof pts[i].a === "number") {
          s += "<circle class=\"dsh-dot\" cx=\"" + Math.round(px(i)) + "\" cy=\"" +
               Math.round(pyA(pts[i].a)) + "\" r=\"2.6\"></circle>";
        }
        if (opt.bLabel && typeof pts[i].b === "number") {
          s += "<circle class=\"dsh-dot-2\" cx=\"" + Math.round(px(i)) + "\" cy=\"" +
               Math.round(pyB(pts[i].b)) + "\" r=\"2.6\"></circle>";
        }
      }
    }

    /* X labels, thinned so they never collide. */
    var step = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(iw / 52))));
    for (i = 0; i < pts.length; i += step) {
      s += "<text class=\"dsh-t-dim\" x=\"" + Math.round(px(i)) + "\" y=\"" + (padT + ih + 18) +
           "\" text-anchor=\"middle\">" + esc(String(pts[i].x)) + "</text>";
    }
    if (opt.xLabel) {
      s += "<text class=\"dsh-t-dim\" x=\"" + Math.round(padL + iw / 2) + "\" y=\"" + (h - 3) +
           "\" text-anchor=\"middle\">" + esc(opt.xLabel) + "</text>";
    }
    return s + "</svg>";
  }

  /* ---- The funnel -------------------------------------------------------
     steps: [{ label, value }] in order. Every row says how many got there and
     what share of the first step that is; between rows, in the stop colour,
     how many were lost on the way. The fall-out is the point of the chart, so
     it is written rather than implied by two bar lengths. */
  function funnelSVG(w, steps, title) {
    if (!steps.length) return "";
    var rowH = 44, dropH = 22, top = 10, i;
    var labW = Math.max(140, Math.min(330, Math.round(w * 0.30)));
    var x0 = labW + 12, valW = 172;
    var barW = w - x0 - valW - 8;
    if (barW < 60) barW = 60;

    var first = steps[0].value || 0;
    var h = top + steps.length * rowH + (steps.length - 1) * dropH + 10;
    var s = svgOpen(w, h, title);
    var y = top;

    for (i = 0; i < steps.length; i++) {
      var v = steps[i].value || 0;
      var frac = first > 0 ? v / first : 0;
      var bh = 22, by = y + 6;
      var fw = Math.max(2, Math.round(barW * frac));

      s += "<rect class=\"dsh-track\" x=\"" + x0 + "\" y=\"" + by + "\" width=\"" + barW +
           "\" height=\"" + bh + "\" rx=\"4\"></rect>";
      s += "<rect class=\"dsh-fill\" x=\"" + (x0 + 0.5) + "\" y=\"" + (by + 0.5) + "\" width=\"" + fw +
           "\" height=\"" + (bh - 1) + "\" rx=\"3.5\"></rect>";
      s += "<text class=\"dsh-t\" x=\"0\" y=\"" + (by + 16) + "\">" +
           esc(clipTo(steps[i].label, labW)) + "</text>";
      s += "<text class=\"dsh-t\" x=\"" + (x0 + barW + 8) + "\" y=\"" + (by + 16) + "\">" +
           esc(fmtInt(v) + " · " + (Math.round(frac * 1000) / 10) + "%") + "</text>";

      y += rowH;

      if (i < steps.length - 1) {
        var next = steps[i + 1].value || 0;
        var lost = v - next;
        var lp = v > 0 ? lost / v : 0;
        s += "<text class=\"dsh-t-drop\" x=\"" + x0 + "\" y=\"" + (y + 12) + "\">" +
             esc(lost > 0
                 ? ("↓ " + fmtInt(lost) + " lost here — " + (Math.round(lp * 1000) / 10) +
                    "% of the step above")
                 : (lost < 0 ? "↑ " + fmtInt(-lost) + " more than the step above"
                             : "↓ nobody lost here")) +
             "</text>";
        y += dropH;
      }
    }
    return s + "</svg>";
  }

  /* ==========================================================================
     Section plumbing
     ========================================================================== */

  function stateOf(id, msg, bad) {
    var el = $(id);
    if (!el) return;
    el.hidden = false;
    el.className = bad ? "dsh-state dsh-bad" : "dsh-state";
    el.textContent = String(msg);
  }

  function bodyOf(ids, on) {
    for (var i = 0; i < ids.length; i++) { if (on) show(ids[i]); else hide(ids[i]); }
  }

  /* Every section's failure path is the same three lines, so it is one
     function: the numbers go away, the reason is written down, and a
     not_admin anywhere takes the whole page with it. Returns true when the
     caller must stop entirely. */
  function notConfigured(err, extra) {
    return err === "upstream" && extra && extra.reason === "not_configured";
  }

  function failed(stateId, bodyIds, err, extra) {
    if (err === "not_admin") { deny(); return true; }
    bodyOf(bodyIds, false);
    /* "Analytics is not connected yet" is a state of the world, not a fault.
       Painting it in the stop colour alongside a real 502 teaches whoever
       opens this before the PostHog key exists to ignore red, which is the
       one thing red is for. */
    var nc = notConfigured(err, extra);
    if (nc) sayNotConfigured();
    stateOf(stateId, saysFor(err, extra), !nc);
    return false;
  }

  function noteOn(id, text) { setText(id, text); show(id); }

  /* ANALYTICS-API.md §7. Every PostHog-backed query answers `upstream` with
     reason `not_configured` until the owner puts a key in Secret Manager, so
     without this the page reads as nine broken panels rather than one
     un-plugged cable. Written once, at the top, the first time any section
     sees it — and the subscriber count below still works, which is the
     evidence that nothing else is wrong. */
  var NOTCONF_NOTE =
    "Analytics is not connected yet, and nothing here is broken. The PostHog " +
    "key and project id have not been put into Secret Manager, so the " +
    "insights function has nothing upstream to ask — every panel below that " +
    "reads PostHog will stay empty until they are. The function itself, the " +
    "admin check and the subscriber count all work without them; the " +
    "subscriber numbers in The funnel are real. To connect it: set " +
    "POSTHOG_API_KEY and POSTHOG_PROJECT_ID with `firebase functions:secrets:set` " +
    "and redeploy the insights function. ANALYTICS-API.md §7 has the commands.";

  var notConfSaid = false;
  function sayNotConfigured() {
    if (notConfSaid) return;
    notConfSaid = true;
    noteOn("dsh-top-note", NOTCONF_NOTE);
  }

  /* The window the SERVER used, not the one this page asked for. meta echoes
     it back after clamping, which is the only figure worth printing. */
  var rangeSaid = false, ASKED = null;
  function sayRange(res) {
    if (rangeSaid || !res || !res.meta) return;
    var m = res.meta;
    if (!m.from || !m.to) return;                 /* subscription_totals has none */
    rangeSaid = true;
    var f = String(m.from).slice(0, 10), t = String(m.to).slice(0, 10);
    var say = "Showing " + f + " to " + t +
              (typeof m.days === "number" ? " — " + m.days + " days" : "") +
              ", as the server scanned it.";
    /* A clamp is the server quietly answering a different question. Say it. */
    if (ASKED && ASKED.from && f > ASKED.from) {
      say += " You asked from " + ASKED.from + " — the window is capped at 90 days, " +
             "so the start moved forward.";
    }
    setText("dsh-range", say);
  }

  function metaSay(res, noun) {
    var m = (res && res.meta) || {};
    var n = typeof m.rows === "number" ? m.rows : ((res && res.rows) ? res.rows.length : 0);
    var took = typeof m.took_ms === "number" ? (" in " + Math.round(m.took_ms) + "ms") : "";
    return fmtInt(n) + " " + noun + took + ".";
  }

  function kpi(n, l) {
    return "<div class=\"dsh-kpi\"><span class=\"dsh-kpi-n\">" + esc(n) +
           "</span><span class=\"dsh-kpi-l\">" + esc(l) + "</span></div>";
  }

  function setKpis(id, html) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = html;
    el.hidden = !html;
  }

  /* A metric/value table carries several units in one column. audio_usage and
     subscription_totals both return { metric, label, value }, so the unit
     lives on the metric name and this is where that is known. */
  function metricText(r) {
    var m = String((r && r.metric) || "");
    var v = r ? r.value : null;
    if (typeof v !== "number") return "—";
    return /_pct$/.test(m) ? fmtPct(v, "pct") : fmtInt(v);
  }

  /* ==========================================================================
     1 · Stories — story_performance
     ========================================================================== */

  var STORY_IDS = [];
  var STORIES_BODY = ["dsh-stories-kpis", "dsh-stories-chartbox", "dsh-stories-key", "dsh-stories-box"];

  function runStories(win) {
    stateOf("dsh-stories-state", "Loading…", false);
    bodyOf(STORIES_BODY, false);
    hide("dsh-stories-note");
    dropChart("dsh-stories-chart");

    ask("story_performance", { from: win.from, to: win.to, limit: 200 }, function (err, res, extra) {
      if (err) { failed("dsh-stories-state", STORIES_BODY, err, extra); return; }
      sayRange(res);

      var rows = (res && res.rows) || [], i;
      if (!rows.length) {
        stateOf("dsh-stories-state",
          "No story was opened in this window. Widen the range — or this is a " +
          "quiet period rather than a broken report.", false);
        return;
      }

      var ids = [];
      for (i = 0; i < rows.length; i++) {
        var id = rows[i].story;
        if (id !== null && id !== undefined) {
          ids.push(String(id));
          var nm = storyName(id);
          if (nm) rows[i].title = nm;
        }
      }
      STORY_IDS = ids;
      fillStoryPicker();

      paintStories(res, rows);

      /* If the catalogue arrives after this did, put the names in. */
      onNames(function () {
        var changed = false;
        for (var j = 0; j < rows.length; j++) {
          var n2 = storyName(rows[j].story);
          if (n2 && rows[j].title !== n2) { rows[j].title = n2; changed = true; }
        }
        if (changed) {
          paintTable("dsh-stories-tbl");
          delete DRAWN["dsh-stories-chart"];
          redrawCharts();
        }
        fillStoryPicker();
      });
    });
  }

  function paintStories(res, rows) {
    var i;
    var viewKey = pick(rows, ["opens", "readers", "views"]);
    var doneKey = pick(rows, ["completion_pct", "completions"]);
    var nameKey = pick(rows, ["title", "story"]);

    var kh = "";
    if (viewKey) {
      var total = 0;
      for (i = 0; i < rows.length; i++) if (typeof rows[i][viewKey] === "number") total += rows[i][viewKey];
      kh += kpi(fmtInt(total), "Story " + labelOf(viewKey).toLowerCase());
    }
    kh += kpi(fmtInt(rows.length), "Stories with a reader");
    if (doneKey) {
      var best = null, worst = null;
      for (i = 0; i < rows.length; i++) {
        var v = rows[i][doneKey];
        if (typeof v !== "number") continue;
        if (!best || v > best[doneKey]) best = rows[i];
        if (!worst || v < worst[doneKey]) worst = rows[i];
      }
      if (best) kh += kpi(fmtCell(doneKey, best[doneKey]), "Best finished: " + nameOf(best));
      if (worst && worst !== best) kh += kpi(fmtCell(doneKey, worst[doneKey]), "Worst finished: " + nameOf(worst));
    }
    setKpis("dsh-stories-kpis", kh);

    if (viewKey) {
      var sorted = rows.slice(0).sort(function (a, b) { return cmpVals(a[viewKey], b[viewKey]) * -1; });
      var items = [];
      for (i = 0; i < sorted.length && i < 14; i++) {
        items.push({
          label: nameOf(sorted[i]),
          value: typeof sorted[i][viewKey] === "number" ? sorted[i][viewKey] : 0,
          right: fmtCell(viewKey, sorted[i][viewKey]) +
                 (doneKey ? " · " + fmtCell(doneKey, sorted[i][doneKey]) + " finished" : "")
        });
      }
      chart("dsh-stories-chart", function (w) {
        return barsSVG(w, items, "Stories by " + labelOf(viewKey).toLowerCase());
      });
      var key = $("dsh-stories-key");
      if (key) {
        key.innerHTML = "<span><i class=\"dsh-key-fill\"></i>" + esc(labelOf(viewKey)) +
          ", top " + Math.min(14, rows.length) + " of " + rows.length +
          (doneKey ? ". The second figure is the share who finished." : ".") + "</span>";
        key.hidden = false;
      }
      show("dsh-stories-chartbox");
    }

    drawTable("dsh-stories-tbl", rows, {
      prefer: ["title", "story", "opens", "completions", "completion_pct", "readers",
               "median_dwell_s", "median_cards", "median_last_card"],
      sort: viewKey || nameKey, dir: -1,
      nameCol: nameKey, subKey: nameKey === "title" ? "story" : null,
      omit: nameKey === "title" ? ["story"] : null
    });
    show("dsh-stories-box");

    stateOf("dsh-stories-state", metaSay(res, "stories"), false);
    noteOn("dsh-stories-note",
      "“Median dwell” is engaged time from story_time: the clock stops while " +
      "the tab is hidden, so a phone left face-down is not counted as reading. " +
      "“They stop on” is the median last card across the readers who finished " +
      "or dropped out.");
  }

  function nameOf(row) {
    if (row.title) return String(row.title);
    var nm = storyName(row.story);
    return nm || (row.story === null || row.story === undefined ? "—" : String(row.story));
  }

  /* ==========================================================================
     2 · Inside a story — card_dropoff, and story_stop_points
     ========================================================================== */

  function fillStoryPicker() {
    var sel = $("dsh-story");
    if (!sel) return;
    var was = sel.value, ids = [], seen = {}, k, i;

    /* Every story in the catalogue, plus any id the function reported that
       the catalogue does not know about — a story that has been renamed or
       retired still has numbers and must still be pickable. */
    for (k in NAMES) { if (has(NAMES, k) && !has(seen, k)) { seen[k] = 1; ids.push(k); } }
    for (i = 0; i < STORY_IDS.length; i++) {
      if (!has(seen, STORY_IDS[i])) { seen[STORY_IDS[i]] = 1; ids.push(STORY_IDS[i]); }
    }
    ids.sort();

    if (!ids.length) {
      sel.innerHTML = "<option value=\"\">No story list available</option>";
      return;
    }

    var h = "<option value=\"\">Choose a story…</option>";
    for (i = 0; i < ids.length; i++) {
      var nm = storyName(ids[i]);
      h += "<option value=\"" + esc(ids[i]) + "\">" +
           esc(ids[i] + (nm ? " · " + nm : "")) + "</option>";
    }
    sel.innerHTML = h;
    if (was && indexOf(ids, was) >= 0) sel.value = was;
  }

  var CARD_STORY = "";
  var CARDS_BODY = ["dsh-cards-kpis", "dsh-cards-chartbox", "dsh-cards-key", "dsh-cards-box"];
  var STOP_BODY = ["dsh-stop-chartbox", "dsh-stop-box"];

  function runCards(win, story) {
    CARD_STORY = story || "";

    if (!CARD_STORY) {
      bodyOf(CARDS_BODY, false);
      bodyOf(STOP_BODY, false);
      hide("dsh-cards-note");
      dropChart("dsh-cards-chart");
      dropChart("dsh-stop-chart");
      stateOf("dsh-cards-state", "Pick a story above to see it card by card.", false);
      stateOf("dsh-stop-state", "Pick a story above.", false);
      setText("dsh-cards-name", " ");
      return;
    }

    var nm = storyName(CARD_STORY);
    setText("dsh-cards-name", nm ? (CARD_STORY + " · " + nm) : ("Story " + CARD_STORY));

    stateOf("dsh-cards-state", "Loading…", false);
    bodyOf(CARDS_BODY, false);
    hide("dsh-cards-note");
    dropChart("dsh-cards-chart");

    ask("card_dropoff", { story: CARD_STORY, from: win.from, to: win.to, limit: 200 }, function (err, res, extra) {
      if (CARD_STORY !== story) return;                 /* they changed their mind */
      if (err) { failed("dsh-cards-state", CARDS_BODY, err, extra); return; }
      sayRange(res);

      var rows = (res && res.rows) || [], i;
      if (!rows.length) {
        stateOf("dsh-cards-state",
          "Nobody spent 900ms on a card of this story in this window.", false);
        return;
      }

      /* The story is the same on every row here, so the column would be one
         repeated value taking up width. */
      for (i = 0; i < rows.length; i++) { try { delete rows[i].story; } catch (e) {} }
      rows.sort(function (a, b) { return cmpVals(a.card, b.card); });

      var kh = "";
      kh += kpi(fmtInt(rows.length), "Cards read");
      if (typeof rows[0].readers === "number") {
        kh += kpi(fmtInt(rows[0].readers), "Readers on card " + String(rows[0].card));
      }
      var last = rows[rows.length - 1];
      if (typeof last.reach_pct === "number") {
        kh += kpi(fmtPct(last.reach_pct, "pct"), "Still there at card " + String(last.card));
      }
      var worst = null;
      for (i = 0; i < rows.length; i++) {
        if (typeof rows[i].dropoff_pct !== "number") continue;
        if (!worst || rows[i].dropoff_pct > worst.dropoff_pct) worst = rows[i];
      }
      if (worst) {
        kh += kpi("Card " + String(worst.card),
                  "Worst fall-off — " + fmtPct(worst.dropoff_pct, "pct") + " lost");
      }
      setKpis("dsh-cards-kpis", kh);

      var pts = [];
      for (i = 0; i < rows.length; i++) {
        pts.push({
          x: String(rows[i].card),
          a: typeof rows[i].median_dwell_s === "number" ? rows[i].median_dwell_s * 1000 : null,
          b: typeof rows[i].reach_pct === "number" ? rows[i].reach_pct : null
        });
      }
      chart("dsh-cards-chart", function (w) {
        return lineSVG(w, pts, {
          title: "Dwell and readers still there, card by card",
          xLabel: "Card number",
          aFmt: function (v) { return fmtMs(v); },
          bLabel: "Still here",
          bFmt: function (v) { return (Math.round(v * 10) / 10) + "%"; }
        });
      });
      var key = $("dsh-cards-key");
      if (key) {
        key.innerHTML =
          "<span><i></i>Median dwell — left axis</span>" +
          "<span><i class=\"dsh-key-2\"></i>Still here, as a share of card 1 — right axis</span>";
        key.hidden = false;
      }
      show("dsh-cards-chartbox");

      drawTable("dsh-cards-tbl", rows, {
        prefer: ["card", "views", "readers", "median_dwell_s", "reach_pct", "dropoff_pct"],
        sort: "card", dir: 1
      });
      show("dsh-cards-box");

      stateOf("dsh-cards-state", metaSay(res, "cards"), false);
      noteOn("dsh-cards-note",
        "A card is only counted once it has been on screen for 900ms or more — " +
        "a swipe passing through is not a reading. These are counts of " +
        "attention, not of scroll position.");
    });

    /* The second half of the question: not how many were still there, but
       which card was the last one they saw. */
    stateOf("dsh-stop-state", "Loading…", false);
    bodyOf(STOP_BODY, false);
    dropChart("dsh-stop-chart");

    ask("story_stop_points", { story: CARD_STORY, from: win.from, to: win.to, limit: 200 }, function (err, res, extra) {
      if (CARD_STORY !== story) return;
      if (err) { failed("dsh-stop-state", STOP_BODY, err, extra); return; }
      sayRange(res);

      var rows = (res && res.rows) || [], i;
      if (!rows.length) {
        stateOf("dsh-stop-state",
          "Nobody stopped part-way through this story in this window.", false);
        return;
      }
      for (i = 0; i < rows.length; i++) { try { delete rows[i].story; } catch (e) {} }
      rows.sort(function (a, b) { return cmpVals(a.last_card, b.last_card); });

      var items = [];
      for (i = 0; i < rows.length; i++) {
        items.push({
          label: "Card " + String(rows[i].last_card),
          value: typeof rows[i].stopped === "number" ? rows[i].stopped : 0,
          right: fmtInt(rows[i].stopped) + " stopped" +
                 (typeof rows[i].share_pct === "number"
                  ? " · " + fmtPct(rows[i].share_pct, "pct") : "")
        });
      }
      chart("dsh-stop-chart", function (w) { return barsSVG(w, items, "Where readers stop"); });
      show("dsh-stop-chartbox");

      drawTable("dsh-stop-tbl", rows, {
        prefer: ["last_card", "stopped", "completed", "sessions", "share_pct"],
        sort: "last_card", dir: 1
      });
      show("dsh-stop-box");
      stateOf("dsh-stop-state", metaSay(res, "stopping points"), false);
    });
  }

  /* ==========================================================================
     3 · The funnel — subscribe_funnel, subscription_totals, checkout_blocks
     ========================================================================== */

  var FUNNEL_NOTE =
    "Two things to know before reading these. First, this is step REACH, not " +
    "a strict ordered funnel: each number is the distinct people who did that " +
    "thing in the window, and it does not verify that the same person did step " +
    "three after step two. For a path this linear the two agree closely, but " +
    "they are not the same measurement. Second, the order is the product's, " +
    "not the pitch's — on the live site the account has to exist before " +
    "checkout, because the Stripe URL carries the Firebase uid, so “Created an " +
    "account” comes before “Reached Stripe”. “Blocked before Stripe” is not a " +
    "step at all; it is a leak, and the table under it says which one.";

  var SUBS_NOTE =
    "The last funnel step is a browser event, and browser events lose 10–25% " +
    "to ad blockers, closed tabs and dead connections. The subscriber count " +
    "above is read straight from Firestore with a count() aggregation and is " +
    "the number that is true. When the two disagree, this one wins.";

  var FUNNEL_BODY = ["dsh-funnel-chartbox", "dsh-funnel-box"];
  var BLOCKS_BODY = ["dsh-blocks-box"];

  function runFunnel(win) {
    stateOf("dsh-funnel-state", "Loading…", false);
    bodyOf(FUNNEL_BODY, false);
    hide("dsh-funnel-note");
    dropChart("dsh-funnel-chart");

    ask("subscribe_funnel", { from: win.from, to: win.to }, function (err, res, extra) {
      if (err) { failed("dsh-funnel-state", FUNNEL_BODY, err, extra); return; }
      sayRange(res);

      var rows = (res && res.rows) || [], i;
      if (!rows.length) {
        stateOf("dsh-funnel-state", "Nobody entered the funnel in this window.", false);
        return;
      }

      /* The blocked row rides along on the same query and is explicitly NOT
         a step — drawing it as one would put a bar below "Subscribed" that
         nothing flows into. */
      var steps = [];
      for (i = 0; i < rows.length; i++) {
        if (String(rows[i].step) === "blocked") continue;
        steps.push({
          label: String(rows[i].label || rows[i].step || ("Step " + (i + 1))),
          value: typeof rows[i].people === "number" ? rows[i].people : 0
        });
      }
      chart("dsh-funnel-chart", function (w) {
        return funnelSVG(w, steps, "The subscription funnel");
      });
      show("dsh-funnel-chartbox");
      noteOn("dsh-funnel-note", FUNNEL_NOTE);

      drawTable("dsh-funnel-tbl", rows, {
        prefer: ["label", "people", "pct_of_first", "pct_of_previous", "step"],
        nameCol: "label"
      });
      show("dsh-funnel-box");
      stateOf("dsh-funnel-state", metaSay(res, "funnel rows"), false);
    });

    stateOf("dsh-blocks-state", "Loading…", false);
    bodyOf(BLOCKS_BODY, false);

    ask("checkout_blocks", { from: win.from, to: win.to, limit: 50 }, function (err, res, extra) {
      if (err) { failed("dsh-blocks-state", BLOCKS_BODY, err, extra); return; }
      sayRange(res);
      var rows = (res && res.rows) || [];
      if (!rows.length) {
        stateOf("dsh-blocks-state",
          "No checkout was blocked in this window. That is the right answer.", false);
        return;
      }
      drawTable("dsh-blocks-tbl", rows, {
        prefer: ["why", "plan", "blocks", "people"], sort: "people", dir: -1, nameCol: "why"
      });
      show("dsh-blocks-box");
      stateOf("dsh-blocks-state", metaSay(res, "reasons"), false);
    });
  }

  function runSubs() {
    setKpis("dsh-subs-kpis", "");
    hide("dsh-subs-note");

    ask("subscription_totals", {}, function (err, res, extra) {
      if (err) {
        if (err === "not_admin") { deny(); return; }
        /* Worth its own line: this query never touches PostHog, so it is the
           one that keeps working when analytics is not configured. */
        noteOn("dsh-subs-note", "Subscriber totals: " + saysFor(err, extra));
        return;
      }
      var rows = (res && res.rows) || [], kh = "", i;
      for (i = 0; i < rows.length; i++) {
        kh += kpi(metricText(rows[i]), String(rows[i].label || rows[i].metric || ""));
      }
      setKpis("dsh-subs-kpis", kh);
      noteOn("dsh-subs-note", SUBS_NOTE);
    });
  }

  /* ==========================================================================
     4 · Onboarding — onboarding_funnel
     ========================================================================== */

  var OB_BODY = ["dsh-ob-kpis", "dsh-ob-chartbox", "dsh-ob-box"];

  function runOnboarding(win) {
    stateOf("dsh-ob-state", "Loading…", false);
    bodyOf(OB_BODY, false);
    dropChart("dsh-ob-chart");

    ask("onboarding_funnel", { from: win.from, to: win.to }, function (err, res, extra) {
      if (err) { failed("dsh-ob-state", OB_BODY, err, extra); return; }
      sayRange(res);

      var rows = (res && res.rows) || [], i;
      if (!rows.length) {
        stateOf("dsh-ob-state", "Nobody started onboarding in this window.", false);
        return;
      }

      var steps = [], done = null;
      for (i = 0; i < rows.length; i++) {
        steps.push({
          /* The raw step id, because that is what join.html calls it and what
             anyone reading this next to the code will recognise. */
          label: String(rows[i].step) + (rows[i].kind === "skip" ? " (skipped)" : ""),
          value: typeof rows[i].people === "number" ? rows[i].people : 0
        });
        if (rows[i].finished === true) done = rows[i];
      }

      var kh = "";
      var first = typeof rows[0].people === "number" ? rows[0].people : 0;
      kh += kpi(fmtInt(first), "Started — " + String(rows[0].step));
      if (done) {
        kh += kpi(fmtInt(done.people), "Finished — " + String(done.step));
        if (first > 0 && typeof done.people === "number") {
          kh += kpi(fmtPct(done.people / first * 100, "pct"), "Finish rate");
        }
      } else {
        kh += kpi("—", "No step is marked as the finish");
      }
      kh += kpi(fmtInt(rows.length), "Steps observed");
      setKpis("dsh-ob-kpis", kh);

      chart("dsh-ob-chart", function (w) {
        return funnelSVG(w, steps, "How far people get through onboarding");
      });
      show("dsh-ob-chartbox");

      drawTable("dsh-ob-tbl", rows, {
        prefer: ["step", "kind", "people", "events", "reach_pct", "finished"],
        nameCol: "step"
      });
      show("dsh-ob-box");
      stateOf("dsh-ob-state", metaSay(res, "steps"), false);
    });
  }

  /* ==========================================================================
     5 · Buttons — button_presses; and one event by day — event_volume
     ========================================================================== */

  var EV_ROWS = [];
  var EV_BODY = ["dsh-ev-chartbox", "dsh-ev-box"];

  function runButtons(win) {
    stateOf("dsh-ev-state", "Loading…", false);
    bodyOf(EV_BODY, false);
    dropChart("dsh-ev-chart");

    var q = "", qi = $("dsh-ev-q");
    if (qi) q = String(qi.value || "").replace(/^\s+|\s+$/g, "");

    var params = { from: win.from, to: win.to, limit: 200 };
    /* The server's own character set for `contains` — anything outside it is
       bad_query, so a search with a comma in it is dropped here rather than
       thrown at the function. */
    if (q && /^[A-Za-z0-9 _.:\/-]{1,40}$/.test(q)) params.contains = q;

    ask("button_presses", params, function (err, res, extra) {
      if (err) { failed("dsh-ev-state", EV_BODY, err, extra); EV_ROWS = []; return; }
      sayRange(res);
      EV_ROWS = (res && res.rows) || [];
      if (!EV_ROWS.length) {
        stateOf("dsh-ev-state", q
          ? ("No button matching “" + q + "” was pressed in this window.")
          : "No button press was recorded in this window.", false);
        return;
      }
      paintButtons();
    });
  }

  function paintButtons() {
    var q = "", qi = $("dsh-ev-q"), i, k;
    if (qi) q = String(qi.value || "").toLowerCase().replace(/^\s+|\s+$/g, "");

    var rows = EV_ROWS;
    if (q) {
      rows = [];
      for (i = 0; i < EV_ROWS.length; i++) {
        var hay = "";
        for (k in EV_ROWS[i]) {
          if (has(EV_ROWS[i], k) && typeof EV_ROWS[i][k] === "string") {
            hay += " " + EV_ROWS[i][k].toLowerCase();
          }
        }
        if (hay.indexOf(q) >= 0) rows.push(EV_ROWS[i]);
      }
    }

    if (!rows.length) {
      bodyOf(EV_BODY, false);
      dropChart("dsh-ev-chart");
      stateOf("dsh-ev-state",
        "Nothing on screen matches “" + q + "”. There are " + fmtInt(EV_ROWS.length) +
        " rows loaded; press Refresh to ask the server for this search instead.", false);
      return;
    }

    var sorted = rows.slice(0).sort(function (a, b) { return cmpVals(a.presses, b.presses) * -1; });
    var items = [];
    for (i = 0; i < sorted.length && i < 16; i++) {
      items.push({
        label: String(sorted[i].control),
        value: typeof sorted[i].presses === "number" ? sorted[i].presses : 0,
        right: fmtInt(sorted[i].presses) + " presses · " + fmtInt(sorted[i].people) + " people"
      });
    }
    chart("dsh-ev-chart", function (w) { return barsSVG(w, items, "Buttons by presses"); });
    show("dsh-ev-chartbox");

    drawTable("dsh-ev-tbl", rows, {
      prefer: ["control", "page", "presses", "people"],
      sort: "presses", dir: -1, nameCol: "control"
    });
    show("dsh-ev-box");

    stateOf("dsh-ev-state",
      q ? (fmtInt(rows.length) + " of " + fmtInt(EV_ROWS.length) + " loaded rows match “" + q + "”.")
        : (fmtInt(EV_ROWS.length) + " button names in this window."),
      false);
  }

  var VOL_BODY = ["dsh-vol-chartbox", "dsh-vol-key", "dsh-vol-box"];

  function fillEventPicker() {
    var sel = $("dsh-vol");
    if (!sel || sel.options.length) return;
    var h = "", i;
    for (i = 0; i < KNOWN_EVENTS.length; i++) {
      h += "<option value=\"" + esc(KNOWN_EVENTS[i]) + "\"" +
           (KNOWN_EVENTS[i] === "page_open" ? " selected" : "") + ">" +
           esc(KNOWN_EVENTS[i]) + "</option>";
    }
    sel.innerHTML = h;
  }

  function runVolume(win, event) {
    stateOf("dsh-vol-state", "Loading…", false);
    bodyOf(VOL_BODY, false);
    dropChart("dsh-vol-chart");
    if (!event) { stateOf("dsh-vol-state", "Pick an event above.", false); return; }

    ask("event_volume", { event: event, from: win.from, to: win.to, limit: 200 }, function (err, res, extra) {
      if (err) { failed("dsh-vol-state", VOL_BODY, err, extra); return; }
      sayRange(res);

      var rows = (res && res.rows) || [], i;
      if (!rows.length) {
        stateOf("dsh-vol-state", "“" + event + "” was not sent at all in this window.", false);
        return;
      }
      rows.sort(function (a, b) { return cmpVals(a.day, b.day); });

      var pts = [];
      for (i = 0; i < rows.length; i++) {
        pts.push({
          x: String(rows[i].day).slice(5),      /* MM-DD; the year is in the range line */
          a: typeof rows[i].events === "number" ? rows[i].events : null,
          b: typeof rows[i].people === "number" ? rows[i].people : null
        });
      }
      chart("dsh-vol-chart", function (w) {
        return lineSVG(w, pts, {
          title: event + " per day",
          xLabel: "Day",
          aFmt: function (v) { return fmtInt(v); },
          bLabel: "People",
          bFmt: function (v) { return fmtInt(v); }
        });
      });
      var key = $("dsh-vol-key");
      if (key) {
        key.innerHTML = "<span><i></i>Events — left axis</span>" +
                        "<span><i class=\"dsh-key-2\"></i>People — right axis</span>";
        key.hidden = false;
      }
      show("dsh-vol-chartbox");

      drawTable("dsh-vol-tbl", rows, { prefer: ["day", "events", "people"], sort: "day", dir: 1 });
      show("dsh-vol-box");
      stateOf("dsh-vol-state", metaSay(res, "days of “" + event + "”"), false);
    });
  }

  /* ==========================================================================
     6 · Audio — audio_usage

     The owner asked two questions here and the data answers one and a half.
     "Are people using the audio button" — yes, this counts that. "Then
     muting the music or playing it" — no, and the reason is specific rather
     than a shrug, so it is written on the page rather than left for someone
     to work out from a chart of one number.
     ========================================================================== */

  /* This note said the split was impossible. It was, and then it was fixed in
     the same afternoon — js/audio-reader.js now sets data-fbt to the state the
     press PRODUCES, so a play and a mute are distinguishable. What survives is
     the older data, which cannot be split retroactively, and saying so is the
     honest version of a caveat rather than a stale complaint. */
  var AUDIO_NOTE =
    "Plays and mutes are counted separately from the moment the sound button " +
    "started naming which way it was pressed. Presses recorded before that are " +
    "shown apart, as “direction not recorded”: the click listener used to walk " +
    "up to the rail's id and log every tap under one name, so those are real " +
    "presses that cannot be split now. They are not folded into either side, " +
    "because putting them on one would invent a direction nobody measured. " +
    "Note too that this counts presses, not listening: a reader who never " +
    "touches the button does not appear here at all.";

  var AUDIO_BODY = ["dsh-audio-kpis", "dsh-audio-chartbox", "dsh-audio-box"];

  function runAudio(win) {
    stateOf("dsh-audio-state", "Loading…", false);
    bodyOf(AUDIO_BODY, false);
    hide("dsh-audio-note");
    dropChart("dsh-audio-chart");

    ask("audio_usage", { from: win.from, to: win.to }, function (err, res, extra) {
      if (err) {
        if (failed("dsh-audio-state", AUDIO_BODY, err, extra)) return;
        /* The play-versus-mute caveat is about a missing attribute, not about
           a missing key. Printing it under "analytics is not connected" reads
           as a second fault when there is only one. */
        if (!notConfigured(err, extra)) noteOn("dsh-audio-note", AUDIO_NOTE);
        return;
      }
      sayRange(res);

      var rows = (res && res.rows) || [], i;
      if (!rows.length) {
        stateOf("dsh-audio-state", "No audio activity came back for this window.", false);
        noteOn("dsh-audio-note", AUDIO_NOTE);
        return;
      }

      var kh = "";
      for (i = 0; i < rows.length; i++) {
        kh += kpi(metricText(rows[i]), String(rows[i].label || rows[i].metric || ""));
      }
      setKpis("dsh-audio-kpis", kh);

      /* Counts only. A percentage and a count share no axis, and a bar chart
         that mixes them lies about their relative size. */
      var items = [];
      for (i = 0; i < rows.length; i++) {
        if (/_pct$/.test(String(rows[i].metric))) continue;
        if (typeof rows[i].value !== "number") continue;
        items.push({
          label: String(rows[i].label || rows[i].metric),
          value: rows[i].value,
          right: fmtInt(rows[i].value)
        });
      }
      if (items.length) {
        chart("dsh-audio-chart", function (w) { return barsSVG(w, items, "Audio usage"); });
        show("dsh-audio-chartbox");
      }

      drawTable("dsh-audio-tbl", rows, {
        prefer: ["label", "metric", "value"], nameCol: "label",
        labels: { label: "Metric", metric: "Id" },
        cellFmt: function (col, val, row) { return col === "value" ? metricText(row) : null; }
      });
      show("dsh-audio-box");
      stateOf("dsh-audio-state", metaSay(res, "audio metrics"), false);
      noteOn("dsh-audio-note", AUDIO_NOTE);
    });
  }

  /* ==========================================================================
     7 · Errors — client_errors
     ========================================================================== */

  var ERR_NOTE =
    "Messages are scrubbed where they are captured: query strings, credentials " +
    "in a URL, email addresses and any unbroken 24-character run — a uid, a " +
    "Stripe id, a restore token — are removed before the event is sent, and " +
    "there is deliberately no stack, because a stack is many lines of many " +
    "URLs and this site puts working secrets in URLs. “Release” is the RELEASE " +
    "constant in js/analytics.js, bumped by hand, so a spike can be pinned to " +
    "a deploy.";

  var ERR_BODY = ["dsh-err-box"];

  function runErrors(win) {
    stateOf("dsh-err-state", "Loading…", false);
    bodyOf(ERR_BODY, false);
    hide("dsh-err-note");

    ask("client_errors", { from: win.from, to: win.to, limit: 200 }, function (err, res, extra) {
      if (err) { failed("dsh-err-state", ERR_BODY, err, extra); return; }
      sayRange(res);
      var rows = (res && res.rows) || [];
      if (!rows.length) {
        stateOf("dsh-err-state",
          "No client error was reported in this window. That is the good outcome.", false);
        noteOn("dsh-err-note", ERR_NOTE);
        return;
      }
      drawTable("dsh-err-tbl", rows, {
        prefer: ["message", "page", "source", "line", "release", "errors", "people", "last_seen"],
        sort: "errors", dir: -1, nameCol: "message"
      });
      show("dsh-err-box");
      stateOf("dsh-err-state", metaSay(res, "distinct errors"), false);
      noteOn("dsh-err-note", ERR_NOTE);
    });
  }

  /* ==========================================================================
     The range, and running everything
     ========================================================================== */

  var DAY_MS = 86400000;

  function isoOf(d) {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /* The two dates in the pickers, defaulted and sanity-checked. Backwards is
     swapped rather than refused — the server does the same — and a span over
     90 days is walked forward here as well as there, so the picker shows the
     window that will actually be scanned instead of one the server silently
     replaced. */
  function currentWindow() {
    var fi = $("dsh-from"), ti = $("dsh-to");
    var f = fi ? String(fi.value || "") : "";
    var t = ti ? String(ti.value || "") : "";
    var re = /^\d{4}-\d{2}-\d{2}$/;
    var today = isoOf(new Date());

    /* Neither picker holds a date — the page has just opened, or a browser
       with no date input has been typed into. Fall back to the default
       window in variables rather than by calling back into this function:
       if the inputs are missing entirely, a recursive retry never ends. */
    if (!re.test(f) && !re.test(t)) {
      setPreset(14);
      f = isoOf(new Date(Date.now() - 13 * DAY_MS));
      t = today;
    }
    if (!re.test(f)) f = t;
    if (!re.test(t)) t = today;
    if (f > t) { var sw = f; f = t; t = sw; }

    var span = Math.round((Date.parse(t + "T00:00:00Z") - Date.parse(f + "T00:00:00Z")) / DAY_MS) + 1;
    if (span > 90) { f = isoOf(new Date(Date.parse(t + "T00:00:00Z") - 89 * DAY_MS)); }

    if (fi) fi.value = f;
    if (ti) ti.value = t;
    return { from: f, to: t };
  }

  /* A preset is just a pair of dates, so there is one window shape and one
     code path. `days` includes today, matching the API's inclusive `to`. */
  function setPreset(days) {
    var now = new Date();
    var then = new Date(now.getTime() - (days - 1) * DAY_MS);
    if ($("dsh-from")) $("dsh-from").value = isoOf(then);
    if ($("dsh-to")) $("dsh-to").value = isoOf(now);
  }

  function syncPickers() {
    var sel = $("dsh-preset");
    var v = sel ? String(sel.value || "") : "14";
    if (v !== "custom") {
      var n = parseInt(v, 10);
      setPreset(isFinite(n) && n > 0 ? n : 14);
    }
    /* Nothing in the future: the window ends now, whatever is typed. */
    var today = isoOf(new Date());
    if ($("dsh-from")) $("dsh-from").max = today;
    if ($("dsh-to")) $("dsh-to").max = today;
  }

  function runAll() {
    GEN++;
    QUEUE.length = 0;
    rangeSaid = false;
    notConfSaid = false;
    hide("dsh-top-note");
    var win = currentWindow();
    ASKED = win;
    var gen = GEN;
    setText("dsh-range", "Asking for " + win.from + " to " + win.to + "…");
    /* If nothing ever comes back with a window — every query failed — the
       line must stop saying "asking" and state what was asked for. */
    try {
      setTimeout(function () {
        if (gen !== GEN || rangeSaid) return;
        setText("dsh-range", "Asked for " + win.from + " to " + win.to +
                             ". Nothing came back with a window to confirm it.");
      }, 6000);
    } catch (e) {}

    /* Ordered by what the owner reads first. The queue runs two at a time, so
       this order is the order the page fills in. */
    runStories(win);
    runFunnel(win);
    runSubs();
    runOnboarding(win);
    runButtons(win);
    runAudio(win);
    runErrors(win);
    var vol = $("dsh-vol");
    runVolume(win, vol ? String(vol.value || "") : "");
    var sel = $("dsh-story");
    runCards(win, sel ? String(sel.value || "") : "");
  }

  function start() {
    running = true;
    /* Hide the panels as well as their container. Leaving #dsh-p-wait with
       hidden=false inside a hidden parent is invisible today and is exactly
       the sort of half-state that shows up on screen the day someone changes
       how the container is hidden. */
    for (var i = 0; i < PANELS.length; i++) hide(PANELS[i]);
    hide("dsh-gate");
    show("dsh-main");
    syncPickers();
    fillStoryPicker();
    fillEventPicker();

    /* The picker is filled from the PUBLIC story catalogue, not from the
       analytics answer, so it must be refilled when that catalogue lands
       whether or not any query succeeded. Registering this only inside the
       stories query left "No story list available" on screen for the whole
       not-configured state — the one state where being able to pick a story
       and see the honest reason matters most. */
    onNames(fillStoryPicker);

    var form = $("dsh-bar");
    if (form) {
      form.onsubmit = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        runAll();
        return false;
      };
    }
    var preset = $("dsh-preset");
    if (preset) { preset.onchange = function () { syncPickers(); runAll(); }; }

    /* Typing a date IS choosing a custom range; saying so beats leaving the
       select claiming "Last 14 days" over two dates that are not that. */
    function toCustom() {
      var p = $("dsh-preset");
      if (p && String(p.value || "") !== "custom") p.value = "custom";
    }
    if ($("dsh-from")) $("dsh-from").onchange = toCustom;
    if ($("dsh-to")) $("dsh-to").onchange = toCustom;

    var cardsBar = $("dsh-cards-bar");
    if (cardsBar) {
      cardsBar.onsubmit = function (e) { if (e && e.preventDefault) e.preventDefault(); return false; };
    }
    var story = $("dsh-story");
    if (story) {
      story.onchange = function () { runCards(currentWindow(), String(story.value || "")); };
    }

    var evBar = $("dsh-ev-bar");
    if (evBar) {
      evBar.onsubmit = function (e) { if (e && e.preventDefault) e.preventDefault(); return false; };
    }
    var evq = $("dsh-ev-q");
    if (evq) {
      var t = null;
      evq.oninput = function () {
        if (t) clearTimeout(t);
        t = setTimeout(function () { if (EV_ROWS.length) paintButtons(); }, 140);
      };
    }

    var volBar = $("dsh-vol-bar");
    if (volBar) {
      volBar.onsubmit = function (e) { if (e && e.preventDefault) e.preventDefault(); return false; };
    }
    var vol = $("dsh-vol");
    if (vol) {
      vol.onchange = function () { runVolume(currentWindow(), String(vol.value || "")); };
    }

    runAll();
  }

  /* ---- Go --------------------------------------------------------------- */

  loadNames();
  whenFBU(boot);

})();
