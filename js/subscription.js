/* ==========================================================================
   Factbox — the subscription screen and the cancellation flow.

   Six steps on one page: the plan, the reason, THE one save attempt, the
   confirmation, and then whichever ending happened — the offer taken, or the
   subscription cancelled. ES5 throughout, because every reader arrives in an
   Instagram or TikTok webview; js/auth.js is the one module on this site and
   this file talks to it through the same whenFBU() bridge every other page
   uses.

   ---------------------------------------------------------------------------
   THE REASON DOES NOT DECIDE ANYTHING

   It used to. There were four save screens and paintOffer() picked one off the
   answer, so only "it costs more than I want to spend" could reach the
   discount and the other three answers went to screens that made no offer at
   all. Three readers in four never saw the one thing that might have kept
   them, which is how the offer came to look deleted.

   Now: one save screen, and every reason reaches it. `why` is read for
   analytics and for nothing else. There is no branch in this file on its
   value and there must never be one again — if you find yourself writing
   `if (why === ...)` around a screen, that is the bug coming back.

   The offer can still be off, and today it is. That is offerLive(), it is a
   switch on the whole offer rather than on an answer, and when it says no
   there is no save attempt to make: the reason step hands the reader straight
   to the confirmation instead of drawing a save screen with nothing on it.

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

   That is what draws step 6. render() refuses to draw the words
   "Subscription cancelled." unless Stripe has said the subscription is
   ending — typing #done into the address bar gets you the plan screen. A
   receipt for a cancellation that did not happen is the single worst thing
   this page could produce, and it is not reachable from here.

   Step 5, "You're all set.", is held to the same rule from the other side: it
   is drawn only when Stripe's own record shows the reader on the discounted
   amount. Typing #saved gets the plan screen too.

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
     switch is off, and while it is off the cancellation goes reason ->
     confirmation with no save screen in between. Nobody is shown a discount
     nobody can redeem, and nobody is shown an empty screen where one was.

     The mockup's own figures are $35 and $17.50. Stripe charges $35.88, so
     amountCents is 1794 and not 1750 — offerLive() below checks that against
     the reader's own amount and will refuse to draw the screen if the two
     disagree, which is exactly the $35-vs-$35.88 defect failing closed.

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

  /* sessionStorage, not localStorage: "I have just gone to Stripe" is true for
     one visit and false forever after. CXL_KEY holds the subscription id so a
     reader who cancels one plan while holding another is not shown a receipt
     for the wrong one; SAVE_KEY is the same idea for the offer. Neither of
     them is evidence of anything on its own — both only say which subscription
     to believe Stripe about when Stripe answers. */
  var CXL_KEY  = "fb_sub_cxl_v1";
  var SAVE_KEY = "fb_sub_saved_v1";
  var WHY_KEY  = "fb_sub_why_v1";

  var BILLING_WAIT_MS = 10000;   /* past FBX.CAP_MS and auth.js's own cap */

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

  /* "You're all set." is a receipt, so it is held to the receipt's rule: it is
     drawn only when Stripe's own record agrees. The proof is the amount on
     customers/{uid}/subscriptions/{id} — written by the webhook off the price
     Stripe charged — being the discounted amount, in the discount's currency,
     on a subscription that is not already on its way out.

     A DISCOUNTED PRICE lights this. A COUPON does not: a coupon leaves the
     price object alone, so the amount on the record stays at full price and
     there is nothing here to check against. If Hassan builds the coupon shape
     (STRIPE.md §10, the second of the two), this screen never draws and the
     reader lands on the plan screen instead — which shows Stripe's own state
     and is true. Saying less is the failure mode this file is allowed. */
  function savedTrue(sub) {
    try {
      var o = SAVE_OFFER;
      if (!(o.amountCents > 0)) return false;
      if (!(o.percentOff > 0 && o.percentOff < 100)) return false;
      if (!sub || typeof sub.amount !== "number") return false;
      if (sub.cancelAtPeriodEnd) return false;
      if (String(sub.currency || "").toLowerCase() !== String(o.currency || "").toLowerCase()) return false;
      return sub.amount === o.amountCents;
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
  var step4  = el("sb-4"), step5 = el("sb-5"), step6 = el("sb-6");
  var pNone  = el("sb-none"), pOut = el("sb-out"), pDead = el("sb-dead");

  var eName  = el("sb-plan-name"), eState = el("sb-plan-state");
  var ePrice = el("sb-plan-price"), eWhen = el("sb-plan-when");
  var ePortal = el("sb-portal"), eLive1 = el("sb-1-live");

  /* One offer, and only one. The three screens that used to sit beside it —
     sb-off-usage, sb-off-content and sb-off-other — are deleted from the
     markup and from here. */
  var offPrice = el("sb-off-price");

  var eSay4 = el("sb-4-say"), eSay5 = el("sb-5-say"), eSay6 = el("sb-6-say");
  var eBack4 = el("sb-back-4");
  var eUntil1 = el("sb-until-1"), eUntil2 = el("sb-until-2");
  var eFact1 = el("sb-fact-until"), eFact2 = el("sb-fact-until-2");
  var eCancel = el("sb-cancel");

  var STEPS = [step1, step2, step3, step4, step5, step6];
  var PANELS = [pNone, pOut, pDead];

  function only(node) {
    var i;
    for (i = 0; i < STEPS.length; i++) show(STEPS[i], STEPS[i] === node);
    for (i = 0; i < PANELS.length; i++) show(PANELS[i], PANELS[i] === node);
  }

  /* ---- the hash router -------------------------------------------------- */

  var HASH = { "": "plan", "#": "plan", "#cancel": "cancel", "#offer": "offer",
               "#confirm": "confirm", "#saved": "saved", "#done": "done" };

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

  /* ---- step 3, THE save attempt ----------------------------------------- */

  /* No argument taken from `why`, on purpose. Every reason reaches this
     screen; the only thing that decides whether it is drawn at all is
     offerLive(), which is the offer being on or off for everybody. render()
     has already refused to route here when it is off, so by the time this
     runs there is a real, redeemable discount whose arithmetic matches this
     reader's own amount. */
  function paintOffer(sub) {
    show(offPrice, true);
    paintPriceOffer(sub);
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

  /* ---- steps 4, 5 and 6 ---------------------------------------------------- */

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
    /* Behind this screen is the offer when there is one and the reason when
       there is not. render() degrades #offer forward to here when the offer is
       off, so a Back button hard-wired to it would land the reader on this
       same screen and look broken. */
    attr(eBack4, "data-step", offerLive(sub) ? "offer" : "cancel");
  }

  /* Step 5. Every figure on it is Stripe's: the amount it is charging now and
     the date it charges next. The percentage is SAVE_OFFER's, and savedTrue()
     has already checked that percentage against the amount Stripe holds — so
     it is not a claim, it is the same fact said in words. */
  function paintSaved(sub) {
    text(eSay5, "Your next year of Factbox is " + SAVE_OFFER.percentOff +
                "% off. Nothing else about your account changes.");

    var pl = priceLine(sub);
    text(el("sb-saved-price"), pl);
    show(el("sb-fact-saved-price"), !!pl);

    var when = dateText(sub && sub.currentPeriodEnd);
    text(el("sb-saved-when"), when);
    show(el("sb-fact-saved-when"), !!when);

    attr(el("sb-portal-4"), "href", portalURL());
  }

  function paintDone(sub) {
    var until = untilText(sub);
    if (until) {
      text(eSay6, "You still have Factbox until " + until + ".");
      text(eUntil2, until);
      show(eFact2, true);
    } else {
      text(eSay6, "Your subscription will not renew. You keep every story " +
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
       only state any of the six steps make sense in. */
    var want = stepFromHash();

    /* #done is not a screen a reader may ask for. Stripe has to have said the
       subscription is ending. */
    if (want === "done" && !sub.cancelAtPeriodEnd) want = "plan";
    /* Nor is #saved. Stripe has to be charging the discounted amount. */
    if (want === "saved" && !savedTrue(sub)) want = "plan";

    /* THE OFFER'S ONE SWITCH, AND IT IS NOT THE REASON. When there is no
       redeemable discount there is no save attempt to make, so the offer step
       degrades forward to the confirmation rather than drawing a screen with
       nothing on it. Note what this is not: it is offerLive(), which knows
       about Stripe and about this reader's own amount and nothing whatever
       about `why`. No answer on step 2 can reach this screen while another
       answer cannot — that was the old shape and it is what made the offer
       look deleted. Rewritten here rather than redirected so that the address
       bar keeps one history entry per tap, the same way #done does. */
    if (want === "offer" && !offerLive(sub)) want = "confirm";

    if (want === "plan") { paintPlan(sub); only(step1); return; }
    if (want === "cancel") { paintReasons(); only(step2); return; }
    if (want === "offer") { paintOffer(sub); only(step3); return; }
    if (want === "confirm") { paintConfirm(sub); only(step4); return; }
    if (want === "saved") { paintSaved(sub); only(step5); return; }
    if (want === "done") { paintDone(sub); only(step6); return; }

    paintPlan(sub);
    only(step1);
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
          /* ONE destination for all four answers, and it is not read off the
             answer. offerLive() is asked instead — "is there an offer at all",
             which is the same question for every reader in the room. When
             there is one, every reason reaches it; when there is not, nobody
             does. Deciding here rather than letting #offer bounce keeps the
             history to one entry per tap and the Back button honest. */
          var next = offerLive(subNow()) ? "offer" : "confirm";
          /* Long enough to see the tick land, short enough not to feel held. */
          setTimeout(function () { goStep(next); }, 170);
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
      /* The same note CXL_KEY carries, for the other ending: which
         subscription the reader went to Stripe about. It grants nothing and
         proves nothing — step 5 is still drawn off Stripe's own amount. */
      try {
        var s0 = subNow();
        ss(SAVE_KEY, (s0 && s0.id) ? s0.id : "1");
      } catch (e) {}
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
     a receipt. Nothing else in this file may move a reader to #done, and
     nothing else may move them to #saved either — both branches below wait for
     Stripe to have written the fact, and the sessionStorage key only says
     which subscription to believe it about. */
  function onSub(sub) {
    try {
      if (sub && sub.cancelAtPeriodEnd && ss(CXL_KEY) && ss(CXL_KEY) === sub.id) {
        ss(CXL_KEY, null);
        goStep("done");
        return;
      }
      /* No id comparison here, and CXL_KEY's is not an oversight this is
         copying badly. A cancellation happens to the subscription the reader
         left with, so the receipt has to name it. The discounted-price shape
         of this offer REPLACES the subscription with a new one (STRIPE.md §10
         says so in as many words), so the id in SAVE_KEY is the old plan's and
         will not match. The evidence that stands either way is savedTrue():
         Stripe is charging the discounted amount on whatever subscription this
         reader now has. */
      if (sub && savedTrue(sub) && ss(SAVE_KEY)) {
        ss(SAVE_KEY, null);
        goStep("saved");
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
