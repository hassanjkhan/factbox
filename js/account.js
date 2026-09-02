/* ==========================================================================
   Factbox — reader account, onboarding answers, and the price ladder.
   Exposes: window.FBA

   This is the storage and arithmetic layer behind join.html. It is the third
   sibling of gate.js (is this reader unlocked right now) and progress.js
   (does that survive, and where did they stop). FBA answers a different
   question: who is this reader, what did they tell us they wanted, and which
   plan did they pick.

   HONEST LIMITATIONS, kept next to the code so they cannot drift:

   1. This is not an account. There is no server, so there is nobody to
      register with and nothing to authenticate against. "Sign up" here means
      "this browser now remembers your email and your preferences". That is
      why there is no password field: a password implies a check we cannot
      perform, and a login form that accepts anything is worse than no login
      form at all.

   2. Because of 1, "log in" cannot move access between devices. The only
      bridge that exists is FBP's restore link, which is a bearer token.
      join.html says this in plain words rather than implying magic.

   3. The email never leaves this browser except in one place: it is appended
      to the Stripe checkout URL as prefilled_email, so the buyer does not
      retype it. Nothing else is transmitted anywhere.

   4. Storage is per-browser and may fail outright. Every access is wrapped.
      A dead store degrades to "not remembered" — never to a broken page.

   Design rules this file obeys without exception:
   - It must never throw. Every storage read, every write, every cookie
     access is wrapped.
   - ES5 only: var and function. No modules, no build step, no network.
   - It does not define, redefine or require FB or FBP. If gate.js never
     loaded, FBA still works; consumers guard window.FBA before use.
   ========================================================================== */

var FBA = (function () {

  /* ======================================================================
     STRIPE PAYMENT LINKS — the only three values an owner has to fill in.

     A Payment Link is a hosted checkout URL. No server and no API key, which
     is the only reason a static site can take money at all. They do not
     exist yet; each one is empty until someone creates it, and every button
     in this file checks for that and says so in plain words rather than
     going dead.

     HOW TO CREATE EACH ONE (Stripe Dashboard, once per link):

       1. Products → Add product → "Factbox — season one".
          Add three recurring prices to that one product:
            a) USD 4.99  / billing period: monthly
            b) USD 11.97 / billing period: every 3 months
            c) USD 35.88 / billing period: yearly
          Stripe bills the whole period at once. The "$3.99 a month" and
          "$2.99 a month" in our copy are those totals divided by the months
          in the period — a description of the same charge, never a separate
          price. plans() below derives them from PRICE_PER_MONTH so the two
          can never drift apart.

       2. Payment Links → New → pick one of the three prices above.

       3. In the link editor, under the subscription options, tick
          "Include a free trial" and set it to 3 days. THE TRIAL IS
          CONFIGURED IN STRIPE, NOT IN THIS CODE — nothing here can grant,
          extend or end a trial, and this file must never claim otherwise.
          (API equivalent: subscription_data.trial_period_days = 3.)

       4. After payment → Redirect customers to:
            https://factbox.app/stories.html?unlocked=1&session_id={CHECKOUT_SESSION_ID}
          Paste that literally, braces included. Stripe substitutes the real
          session id; progress.js mints the buyer's restore link from it, and
          gate.js's claim() flips the unlock flag on arrival. A success URL
          without the session_id part still unlocks, but the restore link
          becomes a locally minted one that no future server could verify.

       5. Copy the resulting https://buy.stripe.com/... URL into the matching
          constant below. Nothing else in the site needs editing.

     Note on what these links can and cannot do: possession of a completed
     checkout is the whole proof of purchase, because there is no server to
     ask Stripe anything. Anyone who visits the success URL by hand is
     unlocked too. SPEC.md §9 already says this; these links do not change it.
     ====================================================================== */

  var PAY_LINK_MONTHLY   = "https://buy.stripe.com/6oUcN41yFgeLbPF5c63F602";   /* USD 4.99  billed every month     + 3-day trial */
  var PAY_LINK_QUARTERLY = "https://buy.stripe.com/4gM6oGfpv7If1b16ga3F603";   /* USD 11.97 billed every 3 months  + 3-day trial */
  var PAY_LINK_ANNUAL    = "https://buy.stripe.com/28E7sKa5b8Mj8DtgUO3F604";   /* USD 35.88 billed every 12 months + 3-day trial */

  /* Stripe's documented Payment Link URL parameters. prefilled_email fills in
     the email field on the payment page (the buyer can still change it);
     client_reference_id is an arbitrary string that comes back on the
     checkout.session.completed webhook, so a future server could join a
     payment to the local account id without reissuing any link.
     client_reference_id must be alphanumerics, dashes or underscores. */
  var P_EMAIL = "prefilled_email";
  var P_REF   = "client_reference_id";

  /* ======================================================================
     The price ladder. THREE NUMBERS, and every other figure on the plan
     screen is computed from them: the billed total, the billing cycle, the
     saving against the monthly rate. A hard-coded "save 40%" is a number
     that silently becomes a lie the first time a price moves.
     ====================================================================== */

  var TRIAL_DAYS = 3;

  var PRICE_PER_MONTH = { monthly: 4.99, quarterly: 3.99, annual: 2.99 };
  var MONTHS          = { monthly: 1,    quarterly: 3,    annual: 12   };
  var CYCLE           = { monthly: "every month", quarterly: "every 3 months",
                          annual: "a year" };
  var CYCLE_SHORT     = { monthly: "monthly", quarterly: "3 months at a time",
                          annual: "once a year" };
  var ORDER           = ["monthly", "quarterly", "annual"];
  var BASE            = "monthly";   /* the rate the savings are measured against */
  var BEST            = "annual";    /* the one marked best value */

  function link(key) {
    if (key === "monthly")   return PAY_LINK_MONTHLY;
    if (key === "quarterly") return PAY_LINK_QUARTERLY;
    if (key === "annual")    return PAY_LINK_ANNUAL;
    return "";
  }

  /* Money, to the cent, always. 3.99 * 3 is 11.969999999999999 in binary
     floating point; rounding to cents before formatting is what makes the
     total read 11.97 rather than 11.96. */
  function cents(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    return Math.round(v * 100);
  }
  function money(n) {
    try { return "$" + (cents(n) / 100).toFixed(2); } catch (e) { return "$0.00"; }
  }

  /* plans() — the whole ladder, derived. Safe to call before anything else,
     and it never throws: the worst case is the three source prices with no
     extras attached. */
  function plans() {
    var out = [], i;
    for (i = 0; i < ORDER.length; i++) {
      var k = ORDER[i];
      var per = PRICE_PER_MONTH[k], months = MONTHS[k];
      var total = cents(per) * months;                 /* integer cents */
      var basePer = PRICE_PER_MONTH[BASE];
      var saveP = 0;
      try {
        if (basePer > 0 && per < basePer) {
          saveP = Math.round((1 - (per / basePer)) * 100);
        }
      } catch (e) { saveP = 0; }
      out.push({
        key: k,
        perMonth: per,
        perMonthText: money(per),
        months: months,
        billedCents: total,
        billed: total / 100,
        billedText: money(total / 100),
        cycle: CYCLE[k],
        cycleShort: CYCLE_SHORT[k],
        /* "$11.97 every 3 months" — the sentence that must never be missing,
           because a per-month figure on a plan billed in a lump is only half
           the truth. */
        billedLine: money(total / 100) + " " + CYCLE[k],
        savePct: saveP,
        best: k === BEST,
        trialDays: TRIAL_DAYS,
        link: link(k),
        ready: !!link(k)
      });
    }
    return out;
  }

  function planByKey(k) {
    var all = plans(), i;
    for (i = 0; i < all.length; i++) { if (all[i].key === k) return all[i]; }
    return null;
  }

  function anyLinkReady() {
    var all = plans(), i;
    for (i = 0; i < all.length; i++) { if (all[i].ready) return true; }
    return false;
  }

  /* checkoutURL(key) — "" means no link is configured for that plan, which is
     the caller's cue to say so rather than to navigate nowhere. */
  function checkoutURL(k) {
    try {
      var p = planByKey(k);
      if (!p || !p.link) return "";
      var url = p.link, sep = url.indexOf("?") === -1 ? "?" : "&";
      var e = email();
      if (e) { url += sep + P_EMAIL + "=" + encodeURIComponent(e); sep = "&"; }
      var a = accountId();
      if (a) { url += sep + P_REF + "=" + encodeURIComponent(a); }
      return url;
    } catch (e2) { return ""; }
  }

  /* ======================================================================
     Storage. One compact key, same discipline as progress.js.
     ====================================================================== */

  var KEY       = "fb_acct_v1";
  var MAX_BYTES = 700;    /* also the cookie-mirror ceiling; see below */
  var MAX_PICKS = 12;     /* eight topics exist; room to grow, still tiny */

  var storeOK = true;     /* false once any write has been refused */

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { storeOK = false; return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); return true; } catch (e) { storeOK = false; return false; }
  }
  function lsDel(k) { try { localStorage.removeItem(k); return true; } catch (e) { return false; } }

  /* The cookie mirror exists for one reason: Instagram's and TikTok's in-app
     webviews hand out a localStorage that is wiped between sessions while
     cookies survive. progress.js mirrors access for the same reason. The
     record is capped so this never becomes a fat cookie riding every
     request — over the cap, the cookie is simply skipped and localStorage
     remains the only store. */
  function ckGet(k) {
    try {
      var all = " " + (document.cookie || "");
      var i = all.indexOf(" " + k + "=");
      if (i === -1) { i = all.indexOf(";" + k + "="); if (i === -1) return null; }
      var s = all.indexOf("=", i) + 1;
      var e = all.indexOf(";", s); if (e === -1) e = all.length;
      return decodeURIComponent(all.slice(s, e));
    } catch (e) { return null; }
  }
  function ckSet(k, v) {
    try {
      if (String(v).length > MAX_BYTES) return false;
      var d = new Date();
      d.setTime(d.getTime() + 365 * 86400000);
      document.cookie = k + "=" + encodeURIComponent(v) +
        ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax" +
        (location.protocol === "https:" ? ";Secure" : "");
      return true;
    } catch (e) { return false; }
  }
  function ckDel(k) {
    try { document.cookie = k + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/"; } catch (e) {}
  }

  /* --- the record ---------------------------------------------------------
     Short field names because every byte here is a byte closer to a quota
     error on a webview with a small budget:
       v  schema version
       a  local account id (for client_reference_id; not a secret)
       e  email
       n  first name
       i  interests, an array of stacks.json topic keys
       f  reading frequency key
       p  chosen plan key
       o  1 once onboarding was finished or skipped through
       t  created, whole seconds
  */

  var _rec = null;

  function blank() {
    return { v: 1, a: "", e: "", n: "", i: [], f: "", p: "", o: 0, t: 0 };
  }

  function nowSec() { try { return Math.floor(Date.now() / 1000); } catch (e) { return 0; } }

  function parse(raw) {
    var r = blank();
    try {
      if (!raw) return r;
      var o = JSON.parse(raw);
      if (!o || typeof o !== "object") return r;
      r.a = typeof o.a === "string" ? o.a.slice(0, 40) : "";
      r.e = typeof o.e === "string" ? o.e.slice(0, 120) : "";
      r.n = typeof o.n === "string" ? o.n.slice(0, 40) : "";
      r.f = typeof o.f === "string" ? o.f.slice(0, 20) : "";
      r.p = typeof o.p === "string" ? o.p.slice(0, 20) : "";
      r.o = o.o ? 1 : 0;
      r.t = Math.floor(Number(o.t)) || 0;
      if (o.i && o.i.length) {
        for (var i = 0; i < o.i.length && r.i.length < MAX_PICKS; i++) {
          var k = o.i[i];
          if (typeof k === "string" && k && r.i.indexOf(k) === -1) r.i.push(k.slice(0, 30));
        }
      }
    } catch (e) { return blank(); }
    return r;
  }

  function rec() {
    if (_rec) return _rec;
    var raw = lsGet(KEY);
    if (!raw) raw = ckGet(KEY);
    _rec = parse(raw);
    return _rec;
  }

  function save() {
    try {
      var r = rec();
      if (!r.t) r.t = nowSec();
      var s = JSON.stringify(r);
      if (s.length > MAX_BYTES) {
        /* Only the picks can grow. Drop them before dropping the email. */
        r.i = r.i.slice(0, 4);
        s = JSON.stringify(r);
      }
      var ok = lsSet(KEY, s);
      ckSet(KEY, s);
      return ok;
    } catch (e) { return false; }
  }

  /* An id for reconciliation only. Math.random is right here: this is a
     join key that a future server could match against a Stripe webhook, not
     a secret that protects anything. */
  function accountId() {
    try {
      var r = rec();
      if (r.a) return r.a;
      var s = "";
      try {
        while (s.length < 16) { s += Math.random().toString(36).slice(2); }
      } catch (e) { s = "0000000000000000"; }
      r.a = ("fba" + s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
      save();
      return r.a;
    } catch (e2) { return ""; }
  }

  /* --- email --------------------------------------------------------------
     Deliberately loose. The only thing a static site can honestly check is
     that a human typed something shaped like an address; anything stricter
     rejects real addresses and buys nothing, because there is no server to
     send a confirmation from. */
  function validEmail(s) {
    try {
      var v = String(s == null ? "" : s).replace(/^\s+|\s+$/g, "");
      if (v.length < 6 || v.length > 120) return false;
      if (v.indexOf(" ") !== -1) return false;
      return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(v);
    } catch (e) { return false; }
  }

  function normalise(s) {
    try { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, "").toLowerCase(); }
    catch (e) { return ""; }
  }

  /* signUp(email, firstName) — false means "that address does not look like
     one", which is the only failure this can honestly report. */
  function signUp(mail, first) {
    try {
      var e = normalise(mail);
      if (!validEmail(e)) return false;
      var r = rec();
      r.e = e.slice(0, 120);
      if (first != null) {
        r.n = String(first).replace(/^\s+|\s+$/g, "").slice(0, 40);
      }
      if (!r.t) r.t = nowSec();
      accountId();
      save();
      return true;
    } catch (e2) { return false; }
  }

  function email() { try { return rec().e || ""; } catch (e) { return ""; } }
  function name()  { try { return rec().n || ""; } catch (e) { return ""; } }
  function has()   { try { return !!rec().e; } catch (e) { return false; } }

  /* knows(email) — the honest core of "log in". It can answer exactly one
     question: has this browser already been told that address. It cannot
     look anyone up, and join.html must not pretend it can. */
  function knows(mail) {
    try {
      var e = normalise(mail);
      return !!e && e === rec().e;
    } catch (e2) { return false; }
  }

  /* --- onboarding answers ------------------------------------------------- */

  function interests() {
    try { return rec().i.slice(0); } catch (e) { return []; }
  }

  function setInterests(list) {
    try {
      var r = rec(), out = [], i;
      if (list && list.length) {
        for (i = 0; i < list.length && out.length < MAX_PICKS; i++) {
          var k = list[i];
          if (typeof k === "string" && k && out.indexOf(k) === -1) out.push(k.slice(0, 30));
        }
      }
      r.i = out;
      save();
      return true;
    } catch (e) { return false; }
  }

  function frequency() { try { return rec().f || ""; } catch (e) { return ""; } }
  function setFrequency(k) {
    try {
      var r = rec();
      r.f = typeof k === "string" ? k.slice(0, 20) : "";
      save();
      return true;
    } catch (e) { return false; }
  }

  function plan() { try { return rec().p || ""; } catch (e) { return ""; } }
  function setPlan(k) {
    try {
      if (!planByKey(k)) return false;
      var r = rec();
      r.p = k;
      save();
      return true;
    } catch (e) { return false; }
  }

  function onboarded() { try { return rec().o === 1; } catch (e) { return false; } }
  function finishOnboarding() {
    try { var r = rec(); r.o = 1; save(); return true; } catch (e) { return false; }
  }

  function forget() {
    try {
      _rec = blank();
      lsDel(KEY); ckDel(KEY);
      return true;
    } catch (e) { return false; }
  }

  /* stored() — false when no store would take a write, so a page can say
     "this phone will not remember you" instead of quietly forgetting. */
  function stored() { return storeOK; }

  /* A whole snapshot, copied rather than shared, so a caller cannot mutate
     the record behind save()'s back. */
  function get() {
    try {
      var r = rec();
      return { accountId: r.a, email: r.e, name: r.n, interests: r.i.slice(0),
               frequency: r.f, plan: r.p, onboarded: r.o === 1, at: r.t * 1000 };
    } catch (e) {
      return { accountId: "", email: "", name: "", interests: [], frequency: "",
               plan: "", onboarded: false, at: 0 };
    }
  }

  return {
    /* who */
    signUp: signUp, has: has, knows: knows, email: email, name: name,
    accountId: accountId, validEmail: validEmail, get: get, forget: forget,
    /* onboarding */
    interests: interests, setInterests: setInterests,
    frequency: frequency, setFrequency: setFrequency,
    onboarded: onboarded, finishOnboarding: finishOnboarding,
    /* money */
    TRIAL_DAYS: TRIAL_DAYS, plans: plans, planByKey: planByKey,
    plan: plan, setPlan: setPlan, checkoutURL: checkoutURL,
    anyLinkReady: anyLinkReady, money: money,
    /* meta */
    stored: stored, KEY: KEY
  };
})();
