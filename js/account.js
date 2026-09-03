/* ==========================================================================
   Factbox — reader account, onboarding answers, and the price ladder.
   Exposes: window.FBA

   This is the storage and arithmetic layer behind join.html. It is the third
   sibling of gate.js (is this reader unlocked right now) and progress.js
   (does that survive, and where did they stop). FBA answers a different
   question: who is this reader, what did they tell us they wanted, and which
   plan did they pick.

   THIS FILE IS STILL THE LOCAL COPY. There is now a backend beside it —
   js/auth.js signs a reader into Firebase, and js/profile-sync.js mirrors
   the record below into `customers/{uid}/profile/onboarding` so it survives
   losing the browser. That is a MIRROR, not a move. Everything here still
   works signed out, still answers from localStorage, still never waits on a
   network, and nothing on the site reads the Firestore copy to decide
   anything. If the sync never happens, this file behaves exactly as it did
   before it existed.

   HONEST LIMITATIONS, kept next to the code so they cannot drift:

   1. This file has no credential field and never will. "Sign up" here means
      "this browser now remembers your email and your answers". A real
      account, with a real password and a real check, is js/auth.js and
      login.html; join.html should be sending readers there before checkout,
      because a payment with no uid attached cannot be honoured on a second
      device.

   2. Because of 1, THIS file's "log in" — knows() — still cannot move
      access between devices; it can only answer "has this browser been told
      that address". The two things that genuinely cross devices are a
      Firebase sign-in and FBP's restore link, which is a bearer token.

   3. Two things leave this browser, both of them deliberate, and nothing
      else does. The email is appended to the Stripe checkout URL as
      prefilled_email so the buyer does not retype it. And, ONLY when a
      reader is signed in, js/profile-sync.js copies the answers below into
      that reader's own Firestore document. Nothing here sends email or push,
      and no copy anywhere may imply that it does. privacy.html has to say
      both of these out loud; see FIREBASE-ANALYTICS.md.

   4. Storage is per-browser and may fail outright. Every access is wrapped.
      A dead store degrades to "not remembered" — never to a broken page.

   5. READER-FACING COPY RULE. join.html never narrates this file's hosting
      model to the reader. It is written in the product's voice — five
      minutes a day, one story, actually remembering it — the same voice the
      iOS onboarding uses, and its questions are a direct port of that flow.
      Anything a reader genuinely needs is said about THEM ("this browser
      will not remember you"), never about our architecture, and never as an
      apology.

   Design rules this file obeys without exception:
   - It must never throw. Every storage read, every write, every cookie
     access is wrapped.
   - ES5 only: var and function. No modules, no build step, no network.
   - It does not define, redefine or require FB or FBP. If gate.js never
     loaded, FBA still works; consumers guard window.FBA before use.
   ========================================================================== */

var FBA = (function () {

  /* ======================================================================
     PRICING — THE SINGLE SOURCE OF TRUTH.

     Everything the reader is ever shown about money is computed from the
     PRICING record below. Nothing else in this repo may contain a price.
     If you are about to type a dollar figure into markup, into copy, or
     into a .md file, you are about to create the bug this block exists to
     make impossible.

     WHY IT IS SHAPED THIS WAY. It used to be shaped the other way round:
     a PRICE_PER_MONTH map was the source, and the billed total was
     per-month x months. That is backwards, and it was one Stripe edit away
     from lying. Stripe charges a TOTAL, once per period. The per-month
     figure is marketing arithmetic performed on that total. Deriving the
     total from the per-month figure means the code can only ever express
     prices that happen to divide evenly — it literally cannot represent
     "$35.00 a year", because no per-month number times twelve is 3500.
     So: `amountCents` is the source, and `perMonth` is derived, rounded,
     and flagged `perMonthExact` when the division is not clean, so copy
     can say "about $2.92 a month" instead of claiming a price nobody is
     charged.

     amountCents IS WHAT STRIPE CHARGES. It is not an aspiration and it is
     not a rounded headline. It was established on 2026-09-03 by loading
     each live Payment Link in Chrome and reading the price object Stripe's
     own checkout fetched for it (see STRIPE.md §2). Each record carries
     the Stripe price id it was read from, so the next person can check the
     same three numbers in the dashboard in under a minute.

     CHANGING A PRICE IS A TWO-STEP OPERATION AND THE ORDER MATTERS:
       1. Hassan creates the new price + Payment Link in Stripe.
       2. Only then does `link` and `amountCents` change here, together,
          in the same edit, on the same line pair.
     Editing `amountCents` alone changes what the site SAYS. Editing `link`
     alone changes what the reader PAYS. Either one on its own is the
     discrepancy. STRIPE.md §7 is the click-path.
     ====================================================================== */

  /* How long the free trial runs. THE TRIAL IS CONFIGURED IN STRIPE, on
     each Payment Link, and this number only describes it — nothing in this
     file can grant, extend or end a trial. It is a constant rather than a
     literal so the 3-vs-7 test is one edit here plus one edit in each of
     the three Stripe links, and so no page has to spell "three" by hand.
     If you change it, change it in Stripe FIRST. */
  var TRIAL_DAYS = 3;

  var PRICING = {
    currency: "USD",
    symbol:   "$",

    /* The ladder, longest-lived first in intent, rendered in ORDER below.

       offered   — is this plan part of the offer a new reader is shown?
                   Setting it to false retires a plan from acquisition
                   WITHOUT deleting anything: the Payment Link keeps
                   working if someone has it bookmarked, the Stripe price
                   is untouched, and every existing subscriber on it keeps
                   renewing at exactly what they agreed to. Nobody is
                   migrated, nobody is repriced, nobody is cancelled.
       best      — the one carrying the BEST VALUE badge. At most one.
       priceId   — the Stripe price the link above resolves to. Recorded so
                   the numbers here can be re-verified without guessing. */
    plans: [
      {
        key:           "monthly",
        link:          "https://buy.stripe.com/6oUcN41yFgeLbPF5c63F602",
        priceId:       "price_1UBG2BAhj1M3E8TlTgdYJ6Xf",
        amountCents:   499,             /* USD 4.99 */
        intervalUnit:  "month",
        intervalCount: 1,
        cycle:         "every month",
        cycleShort:    "monthly",
        offered:       true,
        best:          false
      },
      {
        /* RETIRED FROM ACQUISITION, NOT DELETED. See §6 of STRIPE.md.
           offered:false takes it off the plan screen and nothing else.
           Anyone already subscribed on price_1UBG4LAhj1M3E8TlS3U7Hwto
           keeps being charged USD 11.97 every 3 months, keeps `premium`,
           and never notices. Do not delete this record: planByKeyAny()
           still has to be able to name their plan on the account page, and
           a reader whose stored plan is "quarterly" must not resolve to
           nothing. */
        key:           "quarterly",
        link:          "https://buy.stripe.com/4gM6oGfpv7If1b16ga3F603",
        priceId:       "price_1UBG4LAhj1M3E8TlS3U7Hwto",
        amountCents:   1197,            /* USD 11.97 */
        intervalUnit:  "month",
        intervalCount: 3,
        cycle:         "every 3 months",
        cycleShort:    "3 months at a time",
        offered:       false,
        best:          false
      },
      {
        /* NOT $35. Stripe charges 3588. The owner wants a $35/year price;
           until that price and its Payment Link exist in the dashboard,
           this must keep saying 35.88, because 35.88 is what the reader
           would authorise. When Hassan has made it (STRIPE.md §7), this
           becomes amountCents: 3500 and the new buy.stripe.com URL — two
           values, one edit, and the whole site follows. */
        key:           "annual",
        link:          "https://buy.stripe.com/28E7sKa5b8Mj8DtgUO3F604",
        priceId:       "price_1UBG4pAhj1M3E8Tl1x4YFAzB",
        amountCents:   3588,            /* USD 35.88 */
        intervalUnit:  "year",
        intervalCount: 1,
        cycle:         "a year",
        cycleShort:    "once a year",
        offered:       true,
        best:          true
      }
    ],

    /* The rate savings are measured against. Must be a key above; if it is
       not offered any more, savePct simply comes out 0 rather than wrong. */
    base: "monthly"
  };

  /* Stripe's documented Payment Link URL parameters. prefilled_email fills in
     the email field on the payment page (the buyer can still change it);
     client_reference_id is an arbitrary string that comes back on the
     checkout.session.completed webhook, so the webhook can join a payment to
     the Firebase account that made it.
     client_reference_id must be alphanumerics, dashes or underscores. */
  var P_EMAIL = "prefilled_email";
  var P_REF   = "client_reference_id";


  /* ======================================================================
     Derivation. Nothing below invents a number; it only divides, rounds
     and formats the ones above.
     ====================================================================== */

  /* Months in one billing period, from the interval Stripe actually bills
     on. Anything unrecognised counts as one period, which makes the
     per-month figure equal the charge — understating the saving rather
     than overstating it. */
  function monthsIn(p) {
    try {
      var n = Number(p.intervalCount);
      if (!isFinite(n) || n < 1) n = 1;
      if (p.intervalUnit === "year")  return 12 * n;
      if (p.intervalUnit === "week")  return n / 4;
      if (p.intervalUnit === "day")   return n / 30;
      return n;                       /* "month" */
    } catch (e) { return 1; }
  }

  function rawByKey(key) {
    try {
      var i, list = PRICING.plans;
      for (i = 0; i < list.length; i++) { if (list[i].key === key) return list[i]; }
    } catch (e) {}
    return null;
  }

  function link(key) {
    var p = rawByKey(key);
    return (p && p.link) ? p.link : "";
  }

  /* Money, to the cent, always, and always from integer cents — because
     3.99 * 3 is 11.969999999999999 in binary floating point and the reader
     is entitled to see 11.97. Everything here starts as cents and only
     becomes a decimal at the last moment, inside the formatter. */
  function cents(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    return Math.round(v * 100);
  }
  function moneyCents(c) {
    try {
      var v = Math.round(Number(c));
      if (!isFinite(v)) v = 0;
      return PRICING.symbol + (v / 100).toFixed(2);
    } catch (e) { return PRICING.symbol + "0.00"; }
  }
  /* Kept for callers that already pass dollars. ACCOUNT.md documents it. */
  function money(n) { return moneyCents(cents(n)); }

  /* Small numbers as words, for prose that should not start a sentence with
     a digit. Anything outside the table falls back to the numeral, which is
     always readable even if it is less pretty. */
  var WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven",
               "eight", "nine", "ten", "eleven", "twelve", "thirteen",
               "fourteen"];
  function words(n) {
    try {
      var i = Math.round(Number(n));
      if (i >= 0 && i < WORDS.length) return WORDS[i];
      return String(i);
    } catch (e) { return String(n); }
  }

  function trialDays() { return TRIAL_DAYS; }
  /* "3 days free" — for buttons, where the numeral reads faster. */
  function trialShort() { return TRIAL_DAYS + " days free"; }
  /* "three days free" — for sentences. Capitalise at the call site. */
  function trialWords() { return words(TRIAL_DAYS) + " days free"; }

  /* shape() — one raw record into everything a screen could want to say
     about it. It never throws; the worst case is the charged figure with no
     extras attached, and the charged figure is the one that matters. */
  function shape(raw) {
    var months  = monthsIn(raw);
    var amount  = Math.round(Number(raw.amountCents));
    if (!isFinite(amount) || amount < 0) amount = 0;

    /* The derived per-month figure, and — just as important — whether the
       division was clean. $35.88 a year is exactly $2.99 a month. $35.00 a
       year is NOT $2.92 a month; it is about $2.92 a month, and copy that
       drops the "about" is quoting a price that does not exist. */
    var exact      = months > 0 && (amount % months === 0);
    var perMonthC  = months > 0 ? Math.round(amount / months) : amount;

    var saveP = 0;
    try {
      var b = rawByKey(PRICING.base);
      if (b && b !== raw) {
        var basePerC = Math.round(b.amountCents / monthsIn(b));
        if (basePerC > 0 && perMonthC < basePerC) {
          saveP = Math.round((1 - (perMonthC / basePerC)) * 100);
        }
      }
    } catch (e) { saveP = 0; }

    return {
      key:      raw.key,
      /* what Stripe charges, which is the only figure that must be exact */
      amountCents:  amount,
      billedCents:  amount,
      billed:       amount / 100,
      billedText:   moneyCents(amount),
      currency:     PRICING.currency,
      /* the period it is charged over */
      intervalUnit:  raw.intervalUnit,
      intervalCount: raw.intervalCount,
      months:        months,
      cycle:         raw.cycle,
      cycleShort:    raw.cycleShort,
      /* "$35.88 a year" — the sentence that must never be missing, because a
         per-month figure on a plan billed in a lump is only half the truth. */
      billedLine:    moneyCents(amount) + " " + raw.cycle,
      /* the derived, secondary figure */
      perMonthCents: perMonthC,
      perMonth:      perMonthC / 100,
      perMonthText:  moneyCents(perMonthC),
      perMonthExact: exact,
      /* "$2.99" when it divides cleanly, "about $2.92" when it does not */
      perMonthAbout: (exact ? "" : "about ") + moneyCents(perMonthC),
      savePct:  saveP,
      best:     !!raw.best,
      offered:  !!raw.offered,
      priceId:  raw.priceId,
      trialDays: TRIAL_DAYS,
      link:     raw.link || "",
      ready:    !!raw.link
    };
  }

  /* plans() — THE OFFER. Only the plans a new reader may pick, in ladder
     order. This is what the plan screen renders, so retiring a plan is
     `offered: false` above and nothing else anywhere. */
  function plans() {
    var out = [], i, list = PRICING.plans;
    for (i = 0; i < list.length; i++) {
      if (list[i].offered) out.push(shape(list[i]));
    }
    return out;
  }

  /* allPlans() — THE LADDER, including retired rungs. For anything that has
     to name a plan somebody is already on. Never render the offer from this. */
  function allPlans() {
    var out = [], i, list = PRICING.plans;
    for (i = 0; i < list.length; i++) out.push(shape(list[i]));
    return out;
  }

  /* planByKey() — resolves within THE OFFER, deliberately. join.html restores
     a returning reader's stored plan through this, and a stored "quarterly"
     must NOT come back as a selectable plan once quarterly is retired, or the
     screen shows no plan selected while the button points at a hidden one. */
  function planByKey(k) {
    var raw = rawByKey(k);
    return (raw && raw.offered) ? shape(raw) : null;
  }

  /* planByKeyAny() — resolves within the whole ladder, retired rungs
     included. This is the one to use when the question is "what is this
     existing subscriber paying", not "what may this reader buy". */
  function planByKeyAny(k) {
    var raw = rawByKey(k);
    return raw ? shape(raw) : null;
  }

  function anyLinkReady() {
    var all = plans(), i;
    for (i = 0; i < all.length; i++) { if (all[i].ready) return true; }
    return false;
  }

  /* checkoutURL(key) — "" means no link is configured for that plan, which is
     the caller's cue to say so rather than to navigate nowhere.

     Retired plans still resolve here on purpose: a bookmarked quarterly link
     must keep working, and a reader who somehow arrives with plan=quarterly
     should reach a real checkout rather than a dead button. What retirement
     changes is what we OFFER, not what we honour. */
  function checkoutURL(key) {
    /* Named `dest`, not `link`. A `var link` here shadows the link()
       function above for the whole body — it was calling a `linkFor` that
       does not exist, so every checkout button threw a ReferenceError and
       went nowhere. One identifier, the entire funnel. */
    var dest = link(key);
    if (!dest) return "";
    var parts = [];

    /* The Firebase uid, not our local one. This is the entire link between a
       payment and an account: the webhook reads client_reference_id to know
       which customers/{uid} to write, and without it `premium` can never
       become true for anybody. Falls back to the local id only so a signed-out
       checkout still records something traceable. */
    var ref = "";
    try { if (window.FBU && FBU.uid && FBU.uid()) ref = FBU.uid(); } catch (e) {}
    if (!ref) ref = accountId();

    var mail = "";
    try { if (window.FBU && FBU.email && FBU.email()) mail = FBU.email(); } catch (e) {}
    if (!mail) mail = email();

    if (mail) parts.push(P_EMAIL + "=" + encodeURIComponent(mail));
    if (ref) parts.push(P_REF + "=" + encodeURIComponent(ref));
    return parts.length ? dest + "?" + parts.join("&") : dest;
  }

  /* pricing() — a copy of the source record, for anything that wants to read
     the configuration rather than the rendered ladder. Copied, not shared, so
     a caller cannot edit the price list out from under the plan screen. */
  function pricing() {
    var out = { currency: PRICING.currency, symbol: PRICING.symbol,
                base: PRICING.base, trialDays: TRIAL_DAYS, plans: [] }, i, p, c, k;
    try {
      for (i = 0; i < PRICING.plans.length; i++) {
        p = PRICING.plans[i]; c = {};
        for (k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) c[k] = p[k]; }
        out.plans.push(c);
      }
    } catch (e) {}
    return out;
  }


  /* ======================================================================
     Storage. One compact key, same discipline as progress.js.
     ====================================================================== */

  var KEY       = "fb_acct_v1";
  var MAX_BYTES = 700;    /* also the cookie-mirror ceiling; see below */
  var MAX_PICKS = 12;     /* eight topics exist; room to grow, still tiny */
  var MAX_PLANQ = 3;      /* the plan loader asks exactly three */

  /* ======================================================================
     The funnel's vocabularies, ported one-for-one from the iOS app's
     `OnboardingModel.swift`. They live here rather than in join.html so the
     store can clamp what it accepts, and so a second surface asking the same
     questions cannot invent a fifth answer.

       DRAWS   ← enum HistoryDraw       (people, turningPoints,
                                         howWeGotHere, tiktok)
       RELATES ← enum RelatableStatement (noTime, unfinished, stories)
       GOALS   ← enum DailyGoal          (5, 10, 20, 45 = "as long as it takes")
       STREAKS ← enum StreakCommitment   (7, 14, 30, 50)

     The key names are shortened for the byte budget; the mapping is written
     out in ACCOUNT.md so the two sides stay joinable.

     ADDED for the eleven-screen /join flow. Four of its six questions had no
     field here, so they survived Back and died on a refresh. They are four
     more single-select vocabularies, clamped exactly like DRAWS: the keys ARE
     the data-k attributes in join.html, and nothing else is accepted, so the
     DOM can never put a fifth answer in the record.

       MOTIVES  ← screen 3  "why are you here"
       BARRIERS ← screen 5  "what usually stops you"
       SCROLLS  ← screen 6  "how long a day goes to scrolling"
       FUTURES  ← screen 9  "a year from now"

     These four are LOCAL ONLY today. js/profile-sync.js can carry them the
     moment firestore.rules names them — see the note above the setters.
     ====================================================================== */
  var DRAWS   = ["people", "turning", "thread", "tiktok"];
  var RELATES = ["notime", "unfinished", "stories"];

  /* -1 is the reader saying "you decide", which is a DIFFERENT answer from
     never having been asked. 0 stays the word for unanswered, so the two can
     no longer be confused. It is negative on purpose: every real value here
     is a count of minutes, and there is no minute count this could be
     mistaken for. js/profile-sync.js only mirrors a goal above zero, so this
     sentinel never reaches Firestore, where the rules require >= 0. */
  var GOAL_AUTO = -1;
  var GOALS   = [GOAL_AUTO, 5, 10, 20, 45];
  var STREAKS = [7, 14, 30, 50];

  var MOTIVES  = ["smarter", "understand", "conversation", "less_scrolling",
                  "missed_school"];
  var BARRIERS = ["forget", "bored", "where_to_start", "no_time", "never_return"];
  var SCROLLS  = ["lt30", "m30_60", "h1_2", "h2_3", "too_much"];
  var FUTURES  = ["know_more", "remember", "storyteller", "replaced_scrolling",
                  "routine"];

  /* Clamp a number to one of a fixed set. 0 means "not answered", which is
     distinct from every legal value, so a skipped step stays skipped. */
  function pickFrom(set, v) {
    try {
      var n = Math.floor(Number(v));
      for (var i = 0; i < set.length; i++) { if (set[i] === n) return n; }
    } catch (e) {}
    return 0;
  }

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
       i  interests, an array of stacks.json topic keys   (legacy; see below)
       f  reading frequency key                           (legacy; see below)
       p  chosen plan key
       o  1 once onboarding was finished or skipped through
       t  created, whole seconds

     Added with the ported iOS funnel — the reader's relationship with
     reading, learning and history, which is what that flow actually asks
     about:
       d  what draws them to history: people | turning | thread | tiktok
       r  which of the three "sound familiar" statements they ticked
       g  daily minutes they committed to: 5 | 10 | 20 | 45 (45 = open-ended),
          or -1 for "let Factbox decide". 0 still means nobody answered.
       s  streak they are aiming for, in days: 7 | 14 | 30 | 50
       q  the plan-loader's three yes/no answers, as 1s and 0s

     The four /join questions that used to live only in a tab:
       m  motivation — why they are here
       b  barrier    — what usually stops them
       c  scrolling  — how much of a day goes to the phone
       u  future     — who they want to be a year from now

     `i` and `f` are LEGACY but permanent. The funnel no longer asks which
     subjects you like or how often you read — the iOS flow does not, and
     that is the flow this ports. Other layers already read `interests()`,
     so the whole accessor pair stays defined, keeps parsing what is stored,
     and keeps answering "" / [] when nothing was ever set. Do not delete
     them to tidy up.
  */

  var _rec = null;

  function blank() {
    return { v: 1, a: "", e: "", n: "", i: [], f: "", p: "", o: 0, t: 0,
             d: "", r: [], g: 0, s: 0, q: [],
             m: "", b: "", c: "", u: "" };
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
      /* The funnel answers. Each is clamped to the set it came from, so a
         hand-edited record cannot put an unknown key on screen. */
      r.d = DRAWS.indexOf(String(o.d)) !== -1 ? String(o.d) : "";
      r.g = pickFrom(GOALS, o.g);
      r.s = pickFrom(STREAKS, o.s);
      r.m = MOTIVES.indexOf(String(o.m))  !== -1 ? String(o.m) : "";
      r.b = BARRIERS.indexOf(String(o.b)) !== -1 ? String(o.b) : "";
      r.c = SCROLLS.indexOf(String(o.c))  !== -1 ? String(o.c) : "";
      r.u = FUTURES.indexOf(String(o.u))  !== -1 ? String(o.u) : "";
      if (o.r && o.r.length) {
        for (var j = 0; j < o.r.length && r.r.length < RELATES.length; j++) {
          var s = o.r[j];
          if (typeof s === "string" && RELATES.indexOf(s) !== -1 && r.r.indexOf(s) === -1) {
            r.r.push(s);
          }
        }
      }
      if (o.q && o.q.length) {
        for (var m = 0; m < o.q.length && r.q.length < MAX_PLANQ; m++) {
          r.q.push(o.q[m] ? 1 : 0);
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
        /* Shed in order of what costs least to lose, and never the email:
           legacy topic picks first, then the loader's three yes/nos (theatre,
           and already spent), then the ticked statements. The draw, the daily
           goal and the streak are what the plan screen reads back, so they
           stay. */
        r.i = r.i.slice(0, 4);
        s = JSON.stringify(r);
      }
      if (s.length > MAX_BYTES) { r.q = []; s = JSON.stringify(r); }
      if (s.length > MAX_BYTES) { r.r = []; s = JSON.stringify(r); }
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
     Deliberately loose. The only thing this can honestly check is that a
     human typed something shaped like an address; anything stricter rejects
     real addresses and buys nothing, because nothing here sends a
     confirmation to bounce. */
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

  /* --- the ported iOS answers --------------------------------------------
     Five setters, all the same shape: they clamp to the vocabulary above,
     they save, and they return true only when the value was legal. Passing
     an empty value clears the answer, which is exactly what Skip does — a
     skipped step must be indistinguishable from one never reached, or the
     plan screen reads back something the reader never said. */

  function draw() { try { return rec().d || ""; } catch (e) { return ""; } }
  function setDraw(k) {
    try {
      var r = rec();
      var v = String(k == null ? "" : k);
      if (v && DRAWS.indexOf(v) === -1) return false;
      r.d = v;
      save();
      return true;
    } catch (e) { return false; }
  }

  function relates() { try { return rec().r.slice(0); } catch (e) { return []; } }
  function setRelates(list) {
    try {
      var r = rec(), out = [], i;
      if (list && list.length) {
        for (i = 0; i < list.length; i++) {
          var k = list[i];
          if (typeof k === "string" && RELATES.indexOf(k) !== -1 && out.indexOf(k) === -1) {
            out.push(k);
          }
        }
      }
      r.r = out;
      save();
      return true;
    } catch (e) { return false; }
  }

  /* 0 means unanswered, -1 (GOAL_AUTO) means "let Factbox decide" — a real
     answer, and no longer the same value as never having been asked. goal()
     is the raw answer; the caller decides what to show for each, because
     "five minutes" as a DEFAULT, "five minutes" as a CHOICE and "you pick"
     are three different sentences. */
  function goal() { try { return rec().g || 0; } catch (e) { return 0; } }
  function setGoal(n) {
    try {
      var v = pickFrom(GOALS, n);
      if (!v && n !== 0 && n !== "" && n != null) return false;
      var r = rec();
      r.g = v;
      save();
      return true;
    } catch (e) { return false; }
  }

  function streak() { try { return rec().s || 0; } catch (e) { return 0; } }
  function setStreak(n) {
    try {
      var v = pickFrom(STREAKS, n);
      if (!v && n !== 0 && n !== "" && n != null) return false;
      var r = rec();
      r.s = v;
      save();
      return true;
    } catch (e) { return false; }
  }

  /* --- the four /join answers -------------------------------------------
     Motivation, barrier, scrolling and future self. One shape, four times:
     clamp to the vocabulary, save, return true only when the value was legal.
     An empty value clears the answer, exactly like setDraw, so a skipped step
     stays indistinguishable from one never reached.

     WHY A HELPER AND NOT FOUR COPIES OF setDraw: four identical bodies drift.
     The behaviour is setDraw's, unchanged — the vocabulary and the one-letter
     field are the only things that vary.

     THESE FOUR DO NOT REACH FIRESTORE YET. js/profile-sync.js wraps them, so
     answering one schedules a sync, but its payload cannot carry them until
     firestore.rules names them: that document's key list is `hasOnly(...)`,
     and one unlisted key rejects the WHOLE write — which would silently stop
     mirroring the answers that do sync today. The three edits go together:
     four keys in firestore.rules, four lines in profile-sync's answers(),
     four in its EMPTY. Until then this record is the only home they have, and
     it survives a refresh, which is what it was missing. */
  function setOne(set, field, k) {
    try {
      var v = String(k == null ? "" : k);
      if (v && set.indexOf(v) === -1) return false;
      var r = rec();
      r[field] = v;
      save();
      return true;
    } catch (e) { return false; }
  }

  function motivation() { try { return rec().m || ""; } catch (e) { return ""; } }
  function setMotivation(k) { return setOne(MOTIVES, "m", k); }

  function barrier() { try { return rec().b || ""; } catch (e) { return ""; } }
  function setBarrier(k) { return setOne(BARRIERS, "b", k); }

  function scrolling() { try { return rec().c || ""; } catch (e) { return ""; } }
  function setScrolling(k) { return setOne(SCROLLS, "c", k); }

  function future() { try { return rec().u || ""; } catch (e) { return ""; } }
  function setFuture(k) { return setOne(FUTURES, "u", k); }

  /* The plan loader's three yes/nos. Both answers lead to the same place —
     they are theatre, and the iOS file says so — but they are the reader's,
     so they are kept rather than discarded. */
  function planAnswers() { try { return rec().q.slice(0); } catch (e) { return []; } }
  function addPlanAnswer(yes) {
    try {
      var r = rec();
      if (r.q.length >= MAX_PLANQ) return false;
      r.q.push(yes ? 1 : 0);
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
      /* planByKeyAny, not planByKey: this records the plan somebody HAS, and
         a reader arriving on a bookmarked link for a retired rung is on a
         real plan even though we no longer offer it. What retirement governs
         is what the plan screen renders, not what the store may remember.
         Entitlement never depends on this value either way — the webhook
         writes that. */
      if (!planByKeyAny(k)) return false;
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
               frequency: r.f, plan: r.p, onboarded: r.o === 1, at: r.t * 1000,
               draw: r.d, relates: r.r.slice(0), goal: r.g, streak: r.s,
               planAnswers: r.q.slice(0),
               motivation: r.m, barrier: r.b, scrolling: r.c, future: r.u };
    } catch (e) {
      return { accountId: "", email: "", name: "", interests: [], frequency: "",
               plan: "", onboarded: false, at: 0,
               draw: "", relates: [], goal: 0, streak: 0, planAnswers: [],
               motivation: "", barrier: "", scrolling: "", future: "" };
    }
  }

  return {
    /* who */
    signUp: signUp, has: has, knows: knows, email: email, name: name,
    accountId: accountId, validEmail: validEmail, get: get, forget: forget,
    /* onboarding — the ported iOS questions */
    draw: draw, setDraw: setDraw,
    relates: relates, setRelates: setRelates,
    goal: goal, setGoal: setGoal,
    streak: streak, setStreak: setStreak,
    planAnswers: planAnswers, addPlanAnswer: addPlanAnswer,
    /* onboarding — the four /join questions */
    motivation: motivation, setMotivation: setMotivation,
    barrier: barrier, setBarrier: setBarrier,
    scrolling: scrolling, setScrolling: setScrolling,
    future: future, setFuture: setFuture,
    DRAWS: DRAWS, RELATES: RELATES, GOALS: GOALS, STREAKS: STREAKS,
    MOTIVES: MOTIVES, BARRIERS: BARRIERS, SCROLLS: SCROLLS, FUTURES: FUTURES,
    GOAL_AUTO: GOAL_AUTO,
    /* onboarding — legacy, still read by other layers. Keep defined. */
    interests: interests, setInterests: setInterests,
    frequency: frequency, setFrequency: setFrequency,
    onboarded: onboarded, finishOnboarding: finishOnboarding,
    /* money */
    /* the offer: only plans a new reader may pick */
    plans: plans, planByKey: planByKey,
    /* the whole ladder, retired rungs included, for naming what an existing
       subscriber is on. Never render the offer from these two. */
    allPlans: allPlans, planByKeyAny: planByKeyAny,
    plan: plan, setPlan: setPlan, checkoutURL: checkoutURL,
    anyLinkReady: anyLinkReady, money: money, moneyCents: moneyCents,
    /* the source record itself, copied */
    pricing: pricing, PRICING: pricing(),
    /* the trial, as configuration rather than a literal in someone's copy.
       TRIAL_DAYS stays a plain number because join.html already reads it. */
    TRIAL_DAYS: TRIAL_DAYS, trialDays: trialDays,
    trialShort: trialShort, trialWords: trialWords, words: words,
    /* meta */
    stored: stored, KEY: KEY
  };
})();

/* ==========================================================================
   Loading the mirror.

   js/profile-sync.js copies the record above into Firestore for a signed-in
   reader. It belongs in the markup, next to this file:

       <script src="/js/account.js"></script>
       <script src="/js/profile-sync.js"></script>

   Until that tag is on every page that carries the funnel, this fetches it.
   Doing it from here rather than from js/analytics.js is deliberate: the
   sync has nothing to mirror on a page with no FBA, and analytics.js loads
   on all fifty-one story pages where there is none.

   The whole thing is optional in every direction. If the file is missing, if
   the injection fails, if the reader is signed out, if the rules deny the
   write — nothing about this page changes and no reader sees a thing.
   profile-sync.js refuses to install twice, so having the tag AND this is
   safe; the tag is still the better answer, because a <script> the parser
   sees is one the browser can prioritise.
   ========================================================================== */
(function () {
  "use strict";
  try {
    if (typeof window === "undefined" || !window.document) return;
    if (window.FBPS && window.FBPS.__factbox) return;   /* already installed */

    var d = window.document;
    var here = "";
    try {
      var me = d.currentScript;
      if (me && me.src) here = String(me.src);
    } catch (e) {}
    if (!here) {
      /* No currentScript (an old browser, or this file was inlined). Find the
         tag by name rather than guessing a path that may not be ours. */
      try {
        var all = d.getElementsByTagName("script");
        for (var i = 0; i < all.length; i++) {
          var sv = all[i].getAttribute("src") || "";
          if (sv && sv.indexOf("account.js") !== -1) { here = sv; break; }
        }
      } catch (e2) {}
    }

    var url = here ? here.replace(/account\.js(\?.*)?$/, "profile-sync.js")
                   : "/js/profile-sync.js";
    if (url.indexOf("profile-sync.js") === -1) url = "/js/profile-sync.js";

    /* Already in the markup? Then the markup wins and this does nothing. */
    try {
      var have = d.getElementsByTagName("script");
      for (var j = 0; j < have.length; j++) {
        if ((have[j].getAttribute("src") || "").indexOf("profile-sync.js") !== -1) return;
      }
    } catch (e3) {}

    var add = function () {
      try {
        if (window.FBPS && window.FBPS.__factbox) return;
        var t = d.createElement("script");
        t.src = url;
        t.async = true;
        t.onerror = function () {};        /* a 404 here is not an event */
        var parent = d.head || d.body || d.documentElement;
        if (parent) parent.appendChild(t);
      } catch (e4) {}
    };

    /* After the page has painted. Nothing on screen waits for this. */
    if (d.readyState === "loading") {
      try { d.addEventListener("DOMContentLoaded", function () {
        try { window.setTimeout(add, 0); } catch (e5) { add(); }
      }, false); } catch (e6) { add(); }
    } else {
      try { window.setTimeout(add, 0); } catch (e7) { add(); }
    }
  } catch (e) {}
})();
