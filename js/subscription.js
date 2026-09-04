/* ==========================================================================
   Factbox — the subscription screen and the cancellation flow.

   Five steps on one page: the plan, the reason, one save attempt, the
   confirmation, the receipt. ES5 throughout, because every reader arrives in
   an Instagram or TikTok webview; js/auth.js is the one module on this site
   and this file talks to it through the same whenFBU() bridge every other
   page uses.

   ---------------------------------------------------------------------------
   WHAT ACTUALLY CANCELS, AND WHY IT IS NOT THIS FILE

   Stripe's hosted billing portal. It is already live, it is already linked
   from /account, /support and /terms, and it is the only thing on this site
   that can end a subscription. The confirmation step sends the reader there.
   Stripe then takes the cancellation, works out the proration, sends the
   confirmation email, and fires customer.subscription.updated at the webhook
   in functions/index.js, which writes cancel_at_period_end into
   customers/{uid}/subscriptions/{id}. js/auth.js watches that document with a
   live snapshot, so FBU.subscription() tells this page the truth within a
   second of Stripe knowing it.

   That is what draws step 5. render() refuses to draw the words
   "Subscription cancelled." unless Stripe has said the subscription is
   ending — typing #done into the address bar gets you the plan screen. A
   receipt for a cancellation that did not happen is the single worst thing
   this page could produce, and it is not reachable from here.

   The alternative was cancelling through a Cloud Function on the Stripe API.
   It was not taken: it puts a second writer on the money path, needs the API
   key in a new place, and would have to reimplement proration, dunning and
   the confirmation email that Stripe already does. Fewer moving parts on the
   path that carries revenue.

   ---------------------------------------------------------------------------
   WHERE EVERY NUMBER ON THIS PAGE COMES FROM

   customers/{uid}/subscriptions/{id}, written by the webhook straight off the
   price object Stripe charged: `amount` (in the currency's smallest unit),
   `currency`, `interval`, `intervalCount`, `currentPeriodEnd`, `trialEnd`,
   `status`, `cancelAtPeriodEnd`. Nothing here reads js/account.js's PRICING
   for a figure — that is the ladder a reader may BUY, and a subscriber on a
   retired rung is charged something that is not on it. FBA is used for
   exactly one thing: turning a Stripe price id into the word "Annual".

   A fact that is missing is not on the screen. There is no default amount,
   no assumed currency and above all no computed renewal date: "a year after
   the last one" is a guess, and a guess about somebody's money is a lie with
   arithmetic in front of it.
   ========================================================================== */
(function () {
  "use strict";

  /* ======================================================================
     THE SAVE OFFER. IT IS OFF. READ THIS BEFORE TURNING IT ON.

     The design offers 50% off for another year. **There is no discounted
     price and no coupon in the Stripe account.** STRIPE.md §2 is the
     measurement — three prices on one product, `prod_VBdImvMmh9CI5L`, and
     nothing else — and this repo's hardest rule is that a price shown to a
     reader is exactly what Stripe charges. So the screen is built and the
     switch is off, and a reader who says "too expensive" gets the "anything
     we should know?" screen instead. Nobody is shown a discount nobody can
     redeem.

     To turn it on, Hassan creates the coupon or the discounted price in the
     Stripe dashboard (STRIPE.md §10 is the click-path) and fills in ALL of:

       on            true
       percentOff    the number printed in 80px type. 50 means "50 OFF".
       amountCents   WHAT STRIPE WILL ACTUALLY CHARGE for the discounted
                     period, in cents. Not a percentage of anything: the
                     number off the Stripe price or coupon, read off Stripe.
       currency      the currency that amount is in, lower case, as Stripe
                     writes it.
       months        how many months the discounted period covers, so the
                     terms line can say what happens afterwards.
       thenCents     WHAT STRIPE CHARGES AFTER THOSE MONTHS, in cents. A
                     COUPON reverts to the price it was applied to, so this
                     is the reader's current amount. A discounted PRICE on a
                     Payment Link does not revert at all — it renews at the
                     discounted amount — so this is that amount instead. The
                     screen prints this figure in the sentence beginning
                     "Then", and getting it from the config rather than
                     assuming a revert is the difference between that
                     sentence being true and being a guess.
       link          the URL that applies it — a Payment Link on the
                     discounted price, or a portal flow that redeems the
                     coupon. Empty means the button goes nowhere, so empty
                     keeps the offer off.
       id            the coupon or price id, recorded so the figures above
                     can be re-verified without guessing.

     And then offerLive() still has to agree. It checks the arithmetic against
     THIS READER'S OWN current amount, so the offer cannot be shown to a
     subscriber the discount would not actually produce that price for — a
     quarterly subscriber, say, or somebody on a legacy amount. If the numbers
     do not line up, the offer is off for that reader and they see the other
     screen. That check exists because the $35-vs-$35.88 defect this document
     set is built around is exactly this shape: a figure on a screen that no
     till agrees with.
     ====================================================================== */
  var SAVE_OFFER = {
    on:          false,
    percentOff:  0,
    amountCents: 0,
    currency:    "usd",
    months:      12,
    thenCents:   0,
    link:        "",
    id:          ""
  };

  var PORTAL_FALLBACK = "https://billing.stripe.com/p/login/aFa9AS5OVgeL7zp4823F600";
  var SUPPORT_URL = "https://us-central1-factbox-7cb97.cloudfunctions.net/support";

  /* sessionStorage, not localStorage: "I have just gone to Stripe to cancel"
     is true for one visit and false forever after. It holds the subscription
     id so a reader who cancels one plan while holding another is not shown a
     receipt for the wrong one. */
  var CXL_KEY = "fb_sub_cxl_v1";
  var WHY_KEY = "fb_sub_why_v1";

  var BILLING_WAIT_MS = 10000;   /* past FBX.CAP_MS and auth.js's own cap */
  var NOTE_WAIT_MS    = 6000;

  /* ---- the smallest possible DOM layer -------------------------------- */

  function el(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function show(n, on) { try { if (n) n.hidden = !on; } catch (e) {} }
  function text(n, s) { try { if (n) n.textContent = s; } catch (e) {} }
  function attr(n, k, v) { try { if (n) n.setAttribute(k, v); } catch (e) {} }
  function on(n, ev, fn) {
    try { if (n && n.addEventListener) n.addEventListener(ev, fn, false); } catch (e) {}
  }
  function has(o, k) {
    try { return Object.prototype.hasOwnProperty.call(o, k); } catch (e) { return false; }
  }
  function ss(k, v) {
    try {
      if (v === undefined) return window.sessionStorage.getItem(k);
      if (v === null) { window.sessionStorage.removeItem(k); return null; }
      window.sessionStorage.setItem(k, v);
      return v;
    } catch (e) { return null; }
  }

  /* ---- dates and money, both of them somebody else's facts ------------- */

  var MON = ["January", "February", "March", "April", "May", "June", "July",
             "August", "September", "October", "November", "December"];

  /* A date a reader reads. Empty string means "there is no date", which is a
     different thing from "the date is today" and is why every caller checks
     the result before it writes a sentence around it. */
  function dateText(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return "";
    try {
      var d = new Date(n);
      try {
        var s = d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
        if (s) return s;
      } catch (e) {}
      return d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear();
    } catch (e) { return ""; }
  }

  /* Stripe carries amounts in the currency's smallest unit. Three symbols and
     an honest fallback: "1197 JPY" is ugly and correct, "¥1197" would be
     wrong by a factor of a hundred. */
  function money(cents, currency) {
    try {
      var a = Number(cents);
      if (!isFinite(a) || a < 0) return "";
      var cur = String(currency || "").toUpperCase();
      var sym = (cur === "USD") ? "$" : (cur === "GBP" ? "£" : (cur === "EUR" ? "€" : ""));
      var v = (a / 100).toFixed(2);
      return sym ? (sym + v) : (v + (cur ? " " + cur : ""));
    } catch (e) { return ""; }
  }

  /* "every 3 months", "a year" — from the interval Stripe bills on, not from
     the plan a reader could buy today. */
  function cycleText(sub) {
    try {
      var unit = String((sub && sub.interval) || "");
      var n = 1;
      try { n = Math.round(Number(sub.raw && sub.raw.intervalCount)) || 1; } catch (e) { n = 1; }
      if (n < 1) n = 1;
      if (unit === "year")  return n === 1 ? "a year" : "every " + n + " years";
      if (unit === "month") return n === 1 ? "every month" : "every " + n + " months";
      if (unit === "week")  return n === 1 ? "every week" : "every " + n + " weeks";
      if (unit === "day")   return n === 1 ? "every day" : "every " + n + " days";
      return "";
    } catch (e) { return ""; }
  }

  /* The whole price sentence, or nothing. A per-period figure with no period
     on it is half a fact. */
  function priceLine(sub) {
    try {
      if (!sub || typeof sub.amount !== "number") return "";
      var head = money(sub.amount, sub.currency);
      if (!head) return "";
      var cyc = cycleText(sub);
      return cyc ? (head + " " + cyc) : head;
    } catch (e) { return ""; }
  }

  /* The plan's NAME. FBA knows which price id is which rung, retired rungs
     included — planByKeyAny is the one that can still name a quarterly
     subscriber's plan. If the id is not one of ours (a legacy price, a
     manually created subscription), the interval names it instead. Never
     "Annual" on a guess. */
  var RUNG = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" };

  function planName(sub) {
    var byId = "";
    try {
      var priceId = String((sub && sub.raw && sub.raw.priceId) || "");
      if (priceId && window.FBA && FBA.pricing) {
        var p = FBA.pricing(), i;
        for (i = 0; i < p.plans.length; i++) {
          if (p.plans[i].priceId === priceId) { byId = RUNG[p.plans[i].key] || ""; break; }
        }
      }
    } catch (e) { byId = ""; }
    if (byId) return byId + " plan";

    try {
      var unit = String((sub && sub.interval) || "");
      var n = Math.round(Number(sub.raw && sub.raw.intervalCount)) || 1;
      if (unit === "year" && n === 1)  return "Yearly plan";
      if (unit === "month" && n === 3) return "Quarterly plan";
      if (unit === "month" && n === 1) return "Monthly plan";
      if (unit === "week")             return "Weekly plan";
    } catch (e) {}
    return "Your plan";
  }

  /* The state, in the reader's words, from Stripe's status. Anything this
     does not recognise gets no line rather than a raw enum on the page. */
  function stateOf(sub) {
    try {
      if (!sub) return null;
      if (sub.cancelAtPeriodEnd) return { t: "Cancelling", c: "is-ending" };
      var s = String(sub.status || "");
      if (s === "trialing") return { t: "Free trial", c: "" };
      if (s === "active")   return { t: "Active", c: "" };
      if (s === "past_due") return { t: "Payment overdue", c: "is-late" };
      if (s === "paused")   return { t: "Paused", c: "is-ending" };
    } catch (e) {}
    return null;
  }

  /* "Renews 6 September 2027" / "Ends …" / "First charge …". Every one of
     them is currentPeriodEnd or trialEnd off the Stripe record; no date, no
     line. */
  function whenLine(sub) {
    try {
      if (!sub) return "";
      var end = dateText(sub.currentPeriodEnd);
      if (sub.cancelAtPeriodEnd) return end ? "Ends " + end : "";
      if (sub.status === "trialing") {
        var t = dateText(sub.trialEnd) || end;
        return t ? "Free until " + t : "";
      }
      if (sub.status === "past_due") return end ? "Payment retrying · period ends " + end : "";
      return end ? "Renews " + end : "";
    } catch (e) { return ""; }
  }

  function untilText(sub) {
    try { return dateText(sub && sub.currentPeriodEnd); } catch (e) { return ""; }
  }

  /* ---- the offer's own arithmetic -------------------------------------- */

  /* True only when a real, redeemable discount exists AND the figure we would
     print matches what this reader's own subscription would become. See the
     long note on SAVE_OFFER. */
  function offerLive(sub) {
    try {
      var o = SAVE_OFFER;
      if (!o.on) return false;
      if (!o.link) return false;
      if (!(o.percentOff > 0 && o.percentOff < 100)) return false;
      if (!(o.amountCents > 0)) return false;
      /* No figure for what happens after the discount, no offer. The screen
         has a sentence beginning "Then" and it is not allowed to guess. */
      if (!(o.thenCents > 0)) return false;
      if (!sub || typeof sub.amount !== "number" || sub.amount <= 0) return false;
      if (String(sub.currency || "").toLowerCase() !== String(o.currency || "").toLowerCase()) return false;
      /* The figure on screen has to be the figure the till produces. */
      var expect = Math.round(sub.amount * (100 - o.percentOff) / 100);
      return expect === o.amountCents;
    } catch (e) { return false; }
  }

  /* ---- who this reader is ---------------------------------------------- */

  var FBU = null;

  function signedIn() { try { return !!(FBU && FBU.signedIn()); } catch (e) { return false; } }
  function billingKnown() { try { return !!(FBU && FBU.billingKnown()); } catch (e) { return false; } }
  function premium() { try { return !!(FBU && FBU.premium()); } catch (e) { return false; } }
  function subNow() { try { return (FBU && FBU.subscription()) || null; } catch (e) { return null; } }
  function portalURL() {
    try { return (FBU && FBU.PORTAL) || PORTAL_FALLBACK; } catch (e) { return PORTAL_FALLBACK; }
  }
  function isAdmin() {
    try { if (window.FBX && FBX.isAdmin) return !!FBX.isAdmin(); } catch (e) {}
    try { return !!(FBU && FBU.admin && FBU.admin()); } catch (e) { return false; }
  }
  /* FBX.owns() is "did they buy it" and FBX.can() is "may they read". A cancel
     flow is an owns() question and a narrower one still: only a live Stripe
     subscription has anything to cancel. isLegacy() is the restore-link
     buyer, who owns the season and has no subscription behind it. */
  function isLegacy() {
    try { return !!(window.FBX && FBX.isLegacy && FBX.isLegacy()); } catch (e) { return false; }
  }

  /* ---- the elements ---------------------------------------------------- */

  var wait   = el("sb-wait");
  var stat   = el("sb-static");
  var step1  = el("sb-1"), step2 = el("sb-2"), step3 = el("sb-3");
  var step4  = el("sb-4"), step5 = el("sb-5");
  var pNone  = el("sb-none"), pOut = el("sb-out"), pDead = el("sb-dead");

  var eName  = el("sb-plan-name"), eState = el("sb-plan-state");
  var ePrice = el("sb-plan-price"), eWhen = el("sb-plan-when");
  var ePortal = el("sb-portal"), eLive1 = el("sb-1-live");

  var offPrice = el("sb-off-price"), offUsage = el("sb-off-usage");
  var offContent = el("sb-off-content"), offOther = el("sb-off-other");

  var eSay4 = el("sb-4-say"), eSay5 = el("sb-5-say");
  var eUntil1 = el("sb-until-1"), eUntil2 = el("sb-until-2");
  var eFact1 = el("sb-fact-until"), eFact2 = el("sb-fact-until-2");
  var eCancel = el("sb-cancel");
  var eNote = el("sb-note");

  var STEPS = [step1, step2, step3, step4, step5];
  var PANELS = [pNone, pOut, pDead];

  function only(node) {
    var i;
    for (i = 0; i < STEPS.length; i++) show(STEPS[i], STEPS[i] === node);
    for (i = 0; i < PANELS.length; i++) show(PANELS[i], PANELS[i] === node);
  }

  /* ---- the hash router -------------------------------------------------- */

  var HASH = { "": "plan", "#": "plan", "#cancel": "cancel", "#offer": "offer",
               "#confirm": "confirm", "#done": "done" };

  function stepFromHash() {
    try {
      var h = String(location.hash || "");
      return has(HASH, h) ? HASH[h] : "plan";
    } catch (e) { return "plan"; }
  }

  var routing = false;

  function goStep(name) {
    var target = (name === "plan") ? "#" : ("#" + name);
    try {
      routing = true;
      if (String(location.hash || "") === target ||
          (name === "plan" && !String(location.hash || ""))) {
        routing = false;
        render();
        return;
      }
      location.hash = target;
    } catch (e) {}
    routing = false;
    render();
  }

  /* ---- the reason ------------------------------------------------------- */

  var REASONS = { price: 1, usage: 1, content: 1, other: 1 };
  var why = "";

  function loadWhy() {
    try {
      var v = String(ss(WHY_KEY) || "");
      why = has(REASONS, v) ? v : "";
    } catch (e) { why = ""; }
  }

  function setWhy(v) {
    why = has(REASONS, v) ? v : "";
    ss(WHY_KEY, why || null);
    paintReasons();
  }

  function paintReasons() {
    try {
      var box = el("sb-reasons");
      if (!box) return;
      var b = box.getElementsByTagName("button"), i, k;
      for (i = 0; i < b.length; i++) {
        k = b[i].getAttribute("data-reason");
        attr(b[i], "aria-checked", k && k === why ? "true" : "false");
      }
    } catch (e) {}
  }

  /* ---- step 1 ----------------------------------------------------------- */

  function paintPlan(sub) {
    text(eName, planName(sub));

    var st = stateOf(sub);
    if (st) {
      text(eState, st.t);
      try { eState.className = "sb-plan-state" + (st.c ? " " + st.c : ""); } catch (e) {}
      show(eState, true);
    } else { show(eState, false); }

    var pl = priceLine(sub);
    text(ePrice, pl); show(ePrice, !!pl);

    var wl = whenLine(sub);
    text(eWhen, wl); show(eWhen, !!wl);

    attr(ePortal, "href", portalURL());

    /* The one case where this page has to admit to a delay it cannot remove:
       the reader has just been to Stripe and the webhook has not landed yet.
       Firestore is watched live, so this line disappears on its own. */
    var pending = false;
    try { pending = !!ss(CXL_KEY) && sub && ss(CXL_KEY) === sub.id && !sub.cancelAtPeriodEnd; }
    catch (e) { pending = false; }
    if (pending) {
      text(eLive1, "If you cancelled just now, give Stripe a moment — this page updates itself.");
    }
    show(eLive1, pending);
  }

  /* ---- step 3, the save attempt ----------------------------------------- */

  var recsDrawn = false, usageDrawn = false;

  function paintOffer(sub) {
    var live = (why === "price") && offerLive(sub);
    show(offPrice, live);
    show(offUsage, why === "usage");
    show(offContent, why === "content");
    /* "Something else" is also where a price objection lands while the
       discount does not exist. It asks a real question and quotes no figure. */
    show(offOther, !live && why !== "usage" && why !== "content");

    if (live) paintPriceOffer(sub);
    if (why === "usage" && !usageDrawn) { usageDrawn = true; paintUsage(); }
    if (why === "content" && !recsDrawn) { recsDrawn = true; paintRecs(); }
  }

  function paintPriceOffer(sub) {
    try {
      var o = SAVE_OFFER;
      text(el("sb-off-big"), String(o.percentOff) + "%");
      var then = money(o.thenCents, o.currency);
      var now = money(o.amountCents, o.currency);
      text(el("sb-off-price-line"), now + " for the next " + o.months + " months");
      /* "Then <what Stripe charges next>". Configured, not derived from the
         reader's current amount: a discounted PRICE renews at the discounted
         amount and does not go back up, and a sentence that says it does
         would be this page's one untrue number. */
      text(el("sb-off-terms"), "Then " + then + " " + cycleText(sub) + ". Cancel any time.");
      var b = el("sb-accept");
      text(b, "Take " + o.percentOff + "% off");
      show(el("sb-fan"), false);
      paintFan();
    } catch (e) {}
  }

  /* The fan of covers behind the offer. Decoration, so it is drawn only if
     the covers index actually arrives and it is removed entirely if it does
     not — an empty row of grey rectangles is worse than no row. */
  function paintFan() {
    try {
      if (!window.FB || !FB.loadIndex) return;
      FB.loadIndex().then(function (stacks) {
        try {
          var box = el("sb-fan");
          if (!box || !stacks || !stacks.length) return;
          var i, n = 0, tile;
          box.innerHTML = "";
          for (i = 0; i < stacks.length && n < 5; i += 7) {
            if (!stacks[i] || !stacks[i].img) continue;
            tile = document.createElement("i");
            tile.style.backgroundImage = "url(/img/thumbs/" + stacks[i].img + ".webp)";
            box.appendChild(tile);
            n++;
          }
          show(box, n > 0);
        } catch (e) {}
      }, function () {});
    } catch (e) {}
  }

  /* "You have finished nine stories." A real count off FBP, or no line.
     FBP.visible() is the signed-out gate — a shared phone must not be told
     about the last reader's reading. */
  function paintUsage() {
    try {
      if (!window.FBP || !FBP.all || !FBP.visible || !FBP.visible()) return;
      var m = FBP.all(), k, done = 0, started = 0;
      for (k in m) {
        if (!has(m, k) || !m[k]) continue;
        if (m[k].done) done++; else started++;
      }
      if (done < 1 && started < 1) return;
      var s = "";
      if (done > 0) s = "You have finished " + done + (done === 1 ? " story" : " stories") + ".";
      else s = "You are part-way through " + started + (started === 1 ? " story" : " stories") + ".";
      text(el("sb-usage"), s);
      show(el("sb-usage"), true);
    } catch (e) {}
  }

  /* Three stories this reader has not opened, with their real covers, real
     titles and real lengths. If the index does not arrive, the grid stays
     hidden and the screen is the headline and the buttons — which still make
     sense on their own. */
  function paintRecs() {
    try {
      if (!window.FB || !FB.loadIndex) return;
      FB.loadIndex().then(function (stacks) {
        try {
          var box = el("sb-recs");
          if (!box || !stacks || !stacks.length) return;
          var seen = {};
          try {
            if (window.FBP && FBP.all && FBP.visible && FBP.visible()) seen = FBP.all() || {};
          } catch (e) { seen = {}; }

          var picked = [], i, s;
          for (i = 0; i < stacks.length && picked.length < 3; i++) {
            s = stacks[i];
            if (!s || !s.id || !s.title) continue;
            if (has(seen, String(s.id))) continue;
            picked.push(s);
          }
          /* Everything read already: show the three longest instead of
             nothing, because "there's more waiting" with an empty grid under
             it is a headline contradicting itself. */
          if (!picked.length) {
            for (i = 0; i < stacks.length && picked.length < 3; i++) {
              if (stacks[i] && stacks[i].id && stacks[i].title) picked.push(stacks[i]);
            }
          }
          if (!picked.length) return;

          box.innerHTML = "";
          for (i = 0; i < picked.length; i++) box.appendChild(recCard(picked[i]));
          show(box, true);
        } catch (e) {}
      }, function () {});
    } catch (e) {}
  }

  function recCard(s) {
    var a = document.createElement("a");
    a.setAttribute("href", s.id === "01" ? "/cleopatra" : "/read?s=" + encodeURIComponent(s.id));
    a.setAttribute("data-fbt", "sub_rec_open");

    var plate = document.createElement("div");
    plate.className = "sb-rec-plate";
    if (s.img) {
      var img = document.createElement("img");
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      /* Two fallbacks and then nothing: the thumbnail, the stack hero, and if
         neither lands the plate keeps its own ground and hairline. A broken
         image icon on a save screen is a page that looks abandoned. */
      img.onerror = function () {
        try {
          if (!img.getAttribute("data-tried")) {
            img.setAttribute("data-tried", "1");
            img.src = "/img/stacks/" + s.img + ".webp";
            return;
          }
          img.onerror = null;
          if (img.parentNode) img.parentNode.removeChild(img);
        } catch (e) {}
      };
      img.src = "/img/thumbs/" + s.img + ".webp";
      plate.appendChild(img);
    }
    a.appendChild(plate);

    var b = document.createElement("b");
    b.appendChild(document.createTextNode(String(s.title)));
    a.appendChild(b);

    var sp = document.createElement("span");
    var mins = "";
    try { if (window.FB && FB.minutes) mins = FB.minutes(s.secs); } catch (e) { mins = ""; }
    if (mins) { sp.appendChild(document.createTextNode(mins)); a.appendChild(sp); }
    return a;
  }

  /* ---- steps 4 and 5 ---------------------------------------------------- */

  function paintConfirm(sub) {
    var until = untilText(sub);
    if (until) {
      text(eSay4, "You’ll keep full access until " + until +
                  ". After that, your subscription won’t renew.");
      text(eUntil1, until);
      show(eFact1, true);
    } else {
      /* No date on the record. The sentence stays true by saying less rather
         than by working one out. */
      text(eSay4, "You keep full access until the end of the period you have " +
                  "already paid for. After that, your subscription won’t renew.");
      show(eFact1, false);
    }
    attr(eCancel, "href", portalURL());
  }

  function paintDone(sub) {
    var until = untilText(sub);
    if (until) {
      text(eSay5, "You still have Factbox until " + until + ".");
      text(eUntil2, until);
      show(eFact2, true);
    } else {
      text(eSay5, "Your subscription will not renew. You keep every story " +
                  "until the period you have paid for runs out.");
      show(eFact2, false);
    }
    attr(el("sb-portal-2"), "href", portalURL());
  }

  /* ---- the panels for a reader with nothing to cancel ------------------- */

  var NONE = {
    unknown: {
      h: "We could not check your subscription",
      p: "Your plan is on our records rather than on this phone, and that " +
         "check did not come back — usually a blocked connection, or an " +
         "in-app browser with storage switched off. Nothing about your " +
         "account has changed. Stripe’s billing page below works either way.",
      go: "portal", goText: "Cancel plan or manage billing"
    },
    admin: {
      h: "Nothing here is being charged",
      p: "This account reads everything because of a flag on it, not because " +
         "of a payment, so there is no subscription attached to it and " +
         "nothing to cancel.",
      go: "/explore", goText: "Back to the stories"
    },
    comped: {
      h: "No subscription on file",
      p: "You have full access, but there is no Stripe subscription attached " +
         "to this account — which is what a comped or manually granted " +
         "account looks like. There is nothing recurring to cancel. If you " +
         "think you are being charged, Stripe’s billing page has the record.",
      go: "portal", goText: "Check with Stripe"
    },
    legacy: {
      h: "Your access came from a restore link",
      p: "That is a one-off unlock this browser is holding, not a " +
         "subscription, so there is nothing recurring to cancel and nothing " +
         "being charged. If you do have a card on file, Stripe’s billing " +
         "page has the record.",
      go: "portal", goText: "Check with Stripe"
    },
    free: {
      h: "You don’t have a subscription",
      p: "There is nothing here to cancel. Factbox is fifty-one history " +
         "stories, one free every day, and a subscription opens all of them.",
      go: "/join", goText: "See the plans"
    }
  };

  function paintNone(kind) {
    var c = has(NONE, kind) ? NONE[kind] : NONE.free;
    text(el("sb-none-h"), c.h);
    text(el("sb-none-say"), c.p);
    var g = el("sb-none-go");
    text(g, c.goText);
    if (c.go === "portal") {
      attr(g, "href", portalURL());
      attr(g, "rel", "noopener");
      attr(g, "data-fbt", "-");
    } else {
      attr(g, "href", c.go);
      attr(g, "data-fbt", "sub_none_go");
    }
  }

  /* ---- the render ------------------------------------------------------- */

  var settled = false;   /* has the billing answer arrived, or timed out */
  var drew = false;

  /* The marker the <head> script's timer looks for: "the page script got far
     enough to draw something, do not put the static panel back".

     It is `sb-ready` and not `sb-live` because `.sb-live` is a CLASS IN
     css/subscription.css — the status line under a step's buttons — and a
     class name used for both a state on <html> and a styled element is a rule
     applied to the whole document. It was: `.sb-live{text-align:center}`
     landed on <html> and centred every word on the page. Nothing threw and
     every check passed; it took a screenshot to see it. Do not reuse a
     styled class name as a state flag. */
  function ready() {
    try {
      var h = document.documentElement;
      if (h && h.className.indexOf("sb-ready") === -1) h.className += " sb-ready";
    } catch (e) {}
  }

  function hideWait() {
    try {
      if (window.FBLoad && FBLoad.done && wait) {
        FBLoad.done(wait, function () { show(wait, false); });
      } else { show(wait, false); }
    } catch (e) { show(wait, false); }
  }

  function render() {
    ready();
    show(stat, false);

    if (!FBU) { hideWait(); only(pDead); drew = true; return; }
    if (!signedIn() && !settled) { show(wait, true); only(null); return; }
    if (!signedIn()) { hideWait(); only(pOut); drew = true; return; }
    if (!billingKnown() && !settled) { show(wait, true); only(null); return; }

    hideWait();
    drew = true;

    var sub = subNow();

    if (!sub) {
      var kind = "free";
      if (!billingKnown()) kind = "unknown";
      else if (isAdmin()) kind = "admin";
      else if (premium()) kind = "comped";
      else if (isLegacy()) kind = "legacy";
      paintNone(kind);
      only(pNone);
      return;
    }

    /* From here down the reader has a live Stripe subscription, which is the
       only state any of the five steps make sense in. */
    var want = stepFromHash();

    /* #done is not a screen a reader may ask for. Stripe has to have said the
       subscription is ending. */
    if (want === "done" && !sub.cancelAtPeriodEnd) want = "plan";

    if (want === "plan") { paintPlan(sub); only(step1); return; }
    if (want === "cancel") { paintReasons(); only(step2); return; }
    if (want === "offer") {
      /* Landing straight on the offer with no reason chosen is a refresh or a
         pasted link; the "anything we should know?" screen is the honest
         default and quotes nothing. */
      paintOffer(sub);
      only(step3);
      return;
    }
    if (want === "confirm") { paintConfirm(sub); only(step4); return; }
    if (want === "done") { paintDone(sub); only(step5); return; }

    paintPlan(sub);
    only(step1);
  }

  /* ---- the note box ----------------------------------------------------- */

  /* Read here, and nowhere near anything that reports. What a reader types
     goes to the support inbox and to no analytics sink, ever. */
  function noteText() {
    try {
      if (!eNote) return "";
      var s = String(eNote.value || "").replace(/^\s+|\s+$/g, "");
      return s.length > 3000 ? s.slice(0, 3000) : s;
    } catch (e) { return ""; }
  }

  function idToken(cb) {
    var done = false;
    function go(t) { if (done) return; done = true; cb(t || ""); }
    try {
      var u = (FBU && FBU.user) ? FBU.user() : null;
      if (!u || typeof u.getIdToken !== "function") return go("");
      setTimeout(function () { go(""); }, 2000);
      u.getIdToken().then(function (t) { go(String(t || "")); }, function () { go(""); });
    } catch (e) { go(""); }
  }

  var noteSent = false;

  /* Fired on the way out of the "anything we should know?" screen, in either
     direction. The reader is never held up by it and is never told it
     arrived, because from here we cannot know that it did. */
  function sendNote(body) {
    if (noteSent || !body) return;
    noteSent = true;
    idToken(function (token) {
      var xhr = null, timer = null;
      try { xhr = new XMLHttpRequest(); } catch (e) { return; }
      try {
        xhr.open("POST", SUPPORT_URL, true);
        xhr.setRequestHeader("Content-Type", "application/json");
        if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          try { if (timer) clearTimeout(timer); } catch (e) {}
          if (xhr.status === 200) {
            try { if (window.FB && FB.track) FB.track("support_send"); } catch (e) {}
          }
        };
        xhr.onerror = function () {};
        timer = setTimeout(function () { try { xhr.abort(); } catch (e) {} }, NOTE_WAIT_MS);
        xhr.send(JSON.stringify({
          kind: "help",
          message: "Cancellation note from /subscription:\n\n" + body,
          email: "",
          page: "/subscription"
        }));
      } catch (e) {}
    });
  }

  /* ---- wiring ----------------------------------------------------------- */

  function bind() {
    on(el("sb-start"), "click", function () { goStep("cancel"); });

    /* Every control that only moves between steps, in one delegated handler.
       data-step is the destination; the analytics name is data-fbt, which
       js/analytics.js reads for the ui_click it already sends. */
    on(document, "click", function (ev) {
      var t, hops = 0, dest = "";
      try { t = ev && ev.target; } catch (e) { return; }
      while (t && t.getAttribute && hops++ < 4) {
        dest = t.getAttribute("data-step");
        if (dest) break;
        t = t.parentNode;
      }
      if (!dest) return;
      /* Leaving the note screen in either direction posts what is in the box.
         Nothing on screen claims it was sent. */
      if (offOther && !offOther.hidden) sendNote(noteText());
      goStep(dest);
    });

    /* The reasons. One tap chooses and moves on — a Continue button under a
       four-item list is a tap spent confirming a tap. */
    try {
      var box = el("sb-reasons");
      if (box) {
        on(box, "click", function (ev) {
          var t, hops = 0, k = "";
          try { t = ev && ev.target; } catch (e) { return; }
          while (t && t.getAttribute && hops++ < 4) {
            k = t.getAttribute("data-reason");
            if (k) break;
            t = t.parentNode;
          }
          if (!k) return;
          setWhy(k);
          /* Long enough to see the tick land, short enough not to feel held. */
          setTimeout(function () { goStep("offer"); }, 170);
        });
      }
    } catch (e) {}

    /* Both hops to Stripe. The href is on the element and is never
       preventDefault'd, so the navigation happens whatever this does. */
    on(ePortal, "click", function () {
      try { if (window.FB && FB.track) FB.track("billing_portal"); } catch (e) {}
    });
    on(el("sb-portal-2"), "click", function () {
      try { if (window.FB && FB.track) FB.track("billing_portal"); } catch (e) {}
    });

    /* Taking the save offer. It can only ever go to SAVE_OFFER.link, and
       offerLive() has already refused to draw the button unless that link
       exists — so this can never be a button that does nothing, which is the
       one thing a save screen must not be. */
    on(el("sb-accept"), "click", function () {
      var dest = "";
      try { dest = SAVE_OFFER.link || ""; } catch (e) { dest = ""; }
      if (!dest) return;
      try { if (window.FB && FB.track) FB.track("subscribe_click"); } catch (e) {}
      try { location.href = dest; } catch (e) {}
    });

    /* THE CANCELLATION. This does not cancel anything and does not pretend
       to: it records which subscription the reader went to cancel, so that a
       receipt can only ever be shown for that one, and then Stripe's own page
       takes it from here. */
    on(eCancel, "click", function () {
      try {
        var s = subNow();
        ss(CXL_KEY, (s && s.id) ? s.id : "1");
      } catch (e) {}
      try { if (window.FB && FB.track) FB.track("billing_portal"); } catch (e) {}
    });

    try {
      window.addEventListener("hashchange", function () {
        if (routing) return;
        render();
      }, false);
    } catch (e) {}

    if (eNote) {
      /* A note typed and then abandoned still reaches us if the reader closes
         the tab, which is the commonest way this screen ends. */
      try {
        window.addEventListener("pagehide", function () {
          try { if (offOther && !offOther.hidden) sendNote(noteText()); } catch (e) {}
        }, false);
      } catch (e) {}
    }
  }

  /* ---- boot ------------------------------------------------------------- */

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

  /* The live Firestore snapshot arriving is what turns the confirmation into
     a receipt. Nothing else in this file may move a reader to #done. */
  function onSub(sub) {
    try {
      if (sub && sub.cancelAtPeriodEnd && ss(CXL_KEY) && ss(CXL_KEY) === sub.id) {
        ss(CXL_KEY, null);
        goStep("done");
        return;
      }
    } catch (e) {}
    render();
  }

  loadWhy();
  bind();
  show(wait, true);

  whenFBU(function (api) {
    FBU = api;
    if (!FBU) { settled = true; render(); return; }
    try { attr(ePortal, "href", FBU.PORTAL || PORTAL_FALLBACK); } catch (e) {}
    try { FBU.onReady(function () { render(); }); } catch (e) { render(); }
    try { FBU.onChange(function () { render(); }); } catch (e) {}
    try { FBU.onPremium(function () { render(); }); } catch (e) {}
    try { FBU.onSubscription(function (s) { onSub(s); }); } catch (e) {}
    /* billingReady() settles even when Firestore is blocked or denied, which
       is the case that must not leave a paying reader looking at a bar. */
    try {
      FBU.billingReady().then(function () { settled = true; render(); },
                             function () { settled = true; render(); });
    } catch (e) { settled = true; render(); }
    try {
      setTimeout(function () {
        settled = true;
        if (!drew) render();
      }, BILLING_WAIT_MS);
    } catch (e) {}
  });
})();
