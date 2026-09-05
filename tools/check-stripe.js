/* ==========================================================================
   The money path, end to end, without spending any money.

   Everything here is a regression that has actually happened or that STRIPE.md
   names as the one that must not. It runs in three parts:

     1. THE WEBHOOK. functions/index.js's real handler, with real Stripe
        signatures, against an in-memory stand-in for Firestore. Every
        subscription state, a stale event arriving after a newer one, a retry,
        a deleted customer, and a checkout carrying a LOCAL browser id instead
        of a Firebase uid — the defect that put `customers/fba0c2kqadg5iwjme09b8d4n`
        into production with `premium: true` on it.

     2. THE CHECKOUT URL. /join in a real DOM, signed out, signed in, and with
        Firebase unavailable, reading the `client_reference_id` off the URL the
        page would have sent the buyer to. STRIPE.md §1: that parameter is the
        entire link between a payment and an account.

     3. REVOCATION REACHING THE READER. A subscriber on a paid story, the
        webhook writing `premium: false`, and the screen changing — not just
        the database. And the other half of it: a signed-out reader on a free
        story, who must NOT be reloaded out from under.

   Parts 2 and 3 need the site on a local origin:

       python3 tools/serve-like-pages.py 8899 .
       node tools/check-stripe.js [baseURL]
   ========================================================================== */
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN = path.join(ROOT, "functions");
const BASE = (process.argv[2] || "http://127.0.0.1:8899").replace(/\/$/, "");

let pass = 0, fail = 0;

/* The report writes to stdout directly. firebase-functions installs its own
   console.log on require, and a check whose own output goes through the thing
   it is testing is a check that can go silent — which is exactly what this one
   did until it stopped using console.log. */
const OUT = process.stdout.write.bind(process.stdout);
function say(s) { OUT(s + "\n"); }
function line(ok, label, detail) {
  say("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "\n          " + detail : ""));
  ok ? pass++ : fail++;
}

/* --------------------------------------------------------------------------
   An in-memory Firestore: doc/collection/where/runTransaction and nothing
   else, because nothing else is used. The webhook code under test is the real
   one, unmodified.
   -------------------------------------------------------------------------- */
function makeDb() {
  const store = new Map();
  const SENTINEL = { __serverTimestamp: true };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function apply(p, data, opts) {
    const out = {};
    for (const k of Object.keys(data)) out[k] = data[k] === SENTINEL ? { __ts: Date.now() } : data[k];
    store.set(p, opts && opts.merge && store.has(p) ? Object.assign({}, store.get(p), out) : out);
  }
  function snapOf(p) {
    const has = store.has(p);
    return { exists: has, id: p.split("/").pop(), ref: docRef(p),
             data: () => (has ? clone(store.get(p)) : undefined) };
  }
  function docRef(p) {
    return { path: p, id: p.split("/").pop(),
             set: async (d, o) => apply(p, d, o), get: async () => snapOf(p) };
  }
  function under(col) {
    const out = [];
    for (const p of store.keys()) {
      if (!p.startsWith(col + "/")) continue;
      if (p.slice(col.length + 1).indexOf("/") !== -1) continue;
      out.push(snapOf(p));
    }
    return out;
  }
  function query(col, filters, lim) {
    return {
      where: (f, op, v) => query(col, filters.concat([[f, op, v]]), lim),
      limit: (n) => query(col, filters, n),
      get: async () => {
        let docs = under(col).filter((d) => filters.every(([f, op, v]) => op === "==" && d.data()[f] === v));
        if (lim) docs = docs.slice(0, lim);
        return { empty: !docs.length, docs, size: docs.length, forEach: (cb) => docs.forEach(cb) };
      }
    };
  }
  const db = {
    doc: docRef,
    collection: (p) => Object.assign(query(p, [], 0), { doc: (id) => docRef(p + "/" + id), path: p }),
    batch: () => { const ops = []; return { set: (r, d, o) => ops.push([r.path, d, o]),
                                            commit: async () => ops.forEach((a) => apply(a[0], a[1], a[2])) }; },
    runTransaction: async (fn) => {
      const writes = [];
      const r = await fn({
        get: async (x) => (x.path && x.set ? snapOf(x.path) : x.get()),
        set: (ref, d, o) => writes.push([ref.path, d, o])
      });
      writes.forEach((a) => apply(a[0], a[1], a[2]));
      return r;
    },
    __get: (p) => store.get(p)
  };
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => SENTINEL };
  firestore.Timestamp = { fromMillis: (ms) => ({ __ts: ms }) };
  return { db, firestore };
}

/* -------------------------------------------------------------------------- */
async function partWebhook() {
  say("\n1  the webhook  ·  functions/index.js, real signatures, fake store\n");

  /* Not a secret, and not Stripe's. This string exists only so this file can
     sign the fixtures it made up two lines later and then verify them. The
     real signing secret is in Secret Manager and is never in this repo. */
  const SECRET = "whsec_localtestonlylocaltestonly";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const fake = makeDb();

  const adminPath = require.resolve("firebase-admin", { paths: [FN] });
  require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true,
    exports: { initializeApp: () => ({}), apps: [], firestore: fake.firestore } };
  for (const m of ["story", "support", "today", "insights"]) {
    const p = require.resolve(path.join(FN, m));
    require.cache[p] = { id: p, filename: p, loaded: true,
      exports: { story: 0, support: 0, today: 0, insights: 0 } };
  }
  const Stripe = require(require.resolve("stripe", { paths: [FN] }));
  const stripe = new Stripe("sk_test_unused", { apiVersion: "2024-11-20.acacia" });
  const handler = require(path.join(FN, "index.js")).stripeWebhook;

  /* The webhook's own structured logs are noise here; the report above is
     the evidence. Silenced only for the duration of each POST. */
  function hush(on) {
    process.stdout.write = on ? function () { return true; } : OUT;
  }

  async function post(event, how) {
    how = how || {};
    const payload = JSON.stringify(event);
    const req = {
      method: "POST", body: event, rawBody: Buffer.from(payload, "utf8"),
      headers: how.noSig ? {} : { "stripe-signature": how.badSig ? "t=1,v1=dead"
        : stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) }
    };
    /* firebase-functions wraps the handler in a promise that settles when the
       response emits "finish", so the stand-in has to emit it. */
    let code = 200;
    const fns = {};
    const res = {
      status(c) { code = c; return this; },
      set() { return this; }, setHeader() { return this; },
      on(n2, f) { (fns[n2] = fns[n2] || []).push(f); return this; },
      once(n2, f) { return this.on(n2, f); },
      removeListener() { return this; },
      send() { return this.end(); },
      end() { (fns.finish || []).forEach((f) => f()); return this; }
    };
    hush(true);
    try { await handler(req, res); } finally { hush(false); }
    return code;
  }

  const UID   = "woJ4di0ze9XkQ2rTb8mNpLcVaH3f";   /* 28 chars: a Firebase uid */
  const LOCAL = "fba0c2kqadg5iwjme09b8d4n";        /* 24 chars: the orphan     */
  const CUS   = "cus_CHECK123", SUB = "sub_CHECK123";
  let n = 0, t = 1757000000;

  const sub = (status, over) => Object.assign({
    id: SUB, object: "subscription", status, customer: CUS,
    cancel_at_period_end: false, current_period_end: 1788000000,
    trial_end: status === "trialing" ? 1757200000 : null,
    items: { data: [{ id: "si_1", price: { id: "price_1UBG4pAhj1M3E8Tl1x4YFAzB",
      unit_amount: 3588, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] }
  }, over || {});
  const ev = (type, object, created, id) => ({
    id: id || "evt_" + (++n), object: "event", type, livemode: true,
    created: created || t, data: { object } });

  const cust = () => fake.db.__get("customers/" + UID) || {};
  const row  = (id) => fake.db.__get("customers/" + UID + "/subscriptions/" + (id || SUB)) || {};

  /* --- signature, untouched and still refusing ---------------------------- */
  line(await post(ev("customer.subscription.created", sub("active")), { noSig: true }) === 400,
       "an unsigned POST is refused");
  line(await post(ev("customer.subscription.created", sub("active")), { badSig: true }) === 400,
       "a wrongly signed POST is refused");

  /* --- attribution -------------------------------------------------------- */
  await post(ev("checkout.session.completed", { id: "cs_local", object: "checkout.session",
    client_reference_id: LOCAL, customer: CUS, subscription: "sub_x", amount_total: 3588,
    currency: "usd", customer_details: { email: "buyer@example.com" } }));
  line(!fake.db.__get("customers/" + LOCAL),
       "a LOCAL browser id creates no customers/ row",
       "customers/" + LOCAL + " = " + JSON.stringify(fake.db.__get("customers/" + LOCAL)));
  line(!!fake.db.__get("stripe_unattributed/cs_local"),
       "...it is filed in stripe_unattributed instead, with the join keys",
       JSON.stringify(fake.db.__get("stripe_unattributed/cs_local")));

  await post(ev("checkout.session.completed", { id: "cs_none", object: "checkout.session",
    client_reference_id: null, customer: "cus_NOREF", customer_details: { email: "x@example.com" } }));
  line(!!fake.db.__get("stripe_unattributed/cs_none"),
       "a checkout with no client_reference_id at all is filed too");

  await post(ev("checkout.session.completed", { id: "cs_good", object: "checkout.session",
    client_reference_id: UID, customer: CUS, customer_details: { email: "hassan@example.com" } }));
  line(cust().stripeCustomerId === CUS,
       "a real Firebase uid is joined to the Stripe customer", JSON.stringify(cust()));

  /* --- every state Stripe can put a subscription in ----------------------- */
  const STATES = [
    ["trialing",           true,  "the three-day trial reads"],
    ["active",             true,  "a paid renewal reads"],
    ["past_due",           true,  "a failed card keeps reading — the grace period"],
    ["unpaid",             false, "dunning exhausted revokes"],
    ["incomplete",         false, "never paid revokes"],
    ["incomplete_expired", false, "a trial that ended without payment revokes"],
    ["paused",             false, "paused revokes"],
    ["canceled",           false, "cancelled revokes"]
  ];
  for (const [status, want, why] of STATES) {
    t += 60;
    await post(ev(status === "canceled" ? "customer.subscription.deleted"
                                        : "customer.subscription.updated", sub(status), t));
    line(cust().premium === want,
         status.padEnd(19) + "-> premium " + String(want).padEnd(6) + why,
         "premium=" + cust().premium + "  status=" + row().status);
  }
  t += 60;
  await post(ev("customer.subscription.resumed", sub("active"), t));
  line(cust().premium === true, "resumed             -> premium true   a reader who comes back");

  /* --- out of order, and retried ------------------------------------------ */
  t += 60;
  await post(ev("customer.subscription.deleted", sub("canceled"), t, "evt_cancel"));
  line(cust().premium === false, "the cancellation lands");
  await post(ev("customer.subscription.updated", sub("trialing"), t - 3600, "evt_old_trial"));
  line(cust().premium === false && row().status === "canceled",
       "a STALE trialing arriving after the cancel does not restore access",
       "premium=" + cust().premium + "  status=" + row().status);
  await post(ev("customer.subscription.deleted", sub("canceled"), t, "evt_cancel"));
  line(cust().premium === false, "Stripe retrying the same event changes nothing");
  t += 60;
  await post(ev("customer.subscription.updated", sub("active"), t));
  line(cust().premium === true, "a genuinely NEWER active does restore access");

  /* --- the customer itself is deleted ------------------------------------- */
  t += 60;
  await post(ev("customer.deleted", { id: CUS, object: "customer" }, t));
  line(cust().premium === false && row().active === false,
       "customer.deleted revokes, and marks every subscription inactive");

  /* --- the API version that moved the renewal date ------------------------ */
  t += 60;
  const moved = sub("active", { id: "sub_moved" });
  delete moved.current_period_end;
  moved.items.data[0].current_period_end = 1799999999;
  await post(ev("customer.subscription.created", moved, t));
  line(row("sub_moved").currentPeriodEnd && row("sub_moved").currentPeriodEnd.__ts === 1799999999000,
       "the renewal date survives current_period_end moving onto the item");

  /* --- the orphan row that already exists must not take over --------------
     `customers/fba0c2kqadg5iwjme09b8d4n` is in production carrying this same
     stripeCustomerId. It must not be what a later event resolves to. */
  await fake.db.doc("customers/" + LOCAL).set(
    { uid: LOCAL, premium: true, stripeCustomerId: CUS }, { merge: true });
  t += 60;
  await post(ev("customer.subscription.updated", sub("active"), t, "evt_afterorphan"));
  line(cust().premium === true && (fake.db.__get("customers/" + LOCAL) || {}).premium === true &&
       row().status === "active",
       "an existing orphan row does not hijack the real account's events",
       "real premium=" + cust().premium + "  orphan untouched premium=" +
       (fake.db.__get("customers/" + LOCAL) || {}).premium);

  /* --- an event for a customer nobody owns -------------------------------- */
  t += 60;
  await post(ev("customer.subscription.updated",
    sub("active", { customer: "cus_GHOST", id: "sub_ghost" }), t));
  line(!!fake.db.__get("stripe_unattributed/cus_GHOST"),
       "a subscription for an unknown customer is filed, not silently dropped");

}

/* -------------------------------------------------------------------------- */
let JSDOM, VirtualConsole;
try {
  const j = require(require.resolve("jsdom", { paths: [__dirname] }));
  JSDOM = j.JSDOM; VirtualConsole = j.VirtualConsole;
} catch (e) { /* reported below */ }

function stubFBU(over) {
  const s = Object.assign({ uid: "", email: "", known: true, ok: true,
                            unavailable: false, signedIn: false, premium: false }, over);
  const premFns = [];
  return {
    __state: s, __premFns: premFns,
    __factbox: true,
    ready: () => Promise.resolve(s.signedIn ? { uid: s.uid } : null),
    onReady: (f) => setTimeout(() => f(null), 0),
    known: () => s.known, billingReady: () => Promise.resolve(s.premium),
    ok: () => s.ok, unavailable: () => s.unavailable, timedOut: () => false,
    user: () => (s.signedIn ? { uid: s.uid } : null),
    uid: () => s.uid, email: () => s.email, phone: () => "", name: () => "",
    emailVerified: () => true, signedIn: () => s.signedIn,
    provider: () => "", providers: () => [], providerText: () => "",
    onChange: (f) => { setTimeout(() => f(s.signedIn ? { uid: s.uid } : null), 0); return () => {}; },
    refresh: () => Promise.resolve(),
    premium: () => s.premium, admin: () => false,
    onPremium: (f) => { premFns.push(f); setTimeout(() => f(s.premium), 0); return () => {}; },
    subscription: () => null,
    onSubscription: (f) => { setTimeout(() => f(null), 0); return () => {}; },
    billingKnown: () => true,
    PORTAL: "https://billing.stripe.com/p/login/aFa9AS5OVgeL7zp4823F600",
    signOut: () => Promise.resolve(true)
  };
}

function load(url, prep, waitMs) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  return JSDOM.fromURL(url, {
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, resources: "usable",
    beforeParse(w) {
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {},
                                               addEventListener() {}, removeEventListener() {} }));
      w.fetch = (u, o) => fetch(new URL(String(u), BASE + "/").href, o);
      prep(w, errors);
    }
  }).then((dom) => new Promise((r) => setTimeout(() => r({ dom, errors }), waitMs)));
}

async function partCheckout() {
  say("\n2  the checkout URL  ·  /join in a real DOM, three identities\n");

  const CASES = [
    ["signed out",           { known: true, signedIn: false }, ""],
    ["signed in",            { known: true, signedIn: true, uid: "woJ4di0ze9XkQ2rTb8mNpLcVaH3f",
                               email: "hassan@example.com" }, "woJ4di0ze9XkQ2rTb8mNpLcVaH3f"],
    ["Firebase unavailable", { known: true, ok: false, unavailable: true, signedIn: false }, "fba"]
  ];

  for (const [label, over, wantRef] of CASES) {
    const events = [], urls = [];
    const { dom } = await load(BASE + "/join", (w) => {
      /* A returning reader, so the router lands on the plan screen where the
         buy button lives. Without this the harness measures static markup. */
      try {
        w.localStorage.setItem("fb_acct_v1", JSON.stringify({
          v: 1, a: "", e: "reader@example.com", n: "Reader", p: "annual", o: 1, t: 1757000000 }));
      } catch (e) {}
      /* js/auth.js is an ES module and jsdom does not run one. */
      w.FBU = stubFBU(over);
      let fb; Object.defineProperty(w, "FB", { configurable: true, get: () => fb,
        set(v) { fb = v; if (!v) return; const t = v.track;
                 v.track = (n2, p) => { events.push([n2, p || {}]); try { return t && t.call(v, n2, p); } catch (e) {} }; } });
      /* Record the URL the page would send the buyer to, then hand back ""
         so jsdom never has to navigate. The decision above it is the page's
         own and is not touched. */
      let fba; Object.defineProperty(w, "FBA", { configurable: true, get: () => fba,
        set(v) { fba = v; if (!v || !v.checkoutURL) return; const real = v.checkoutURL;
                 v.checkoutURL = (k) => { const u = real.call(v, k); urls.push(u); return ""; }; } });
    }, 2600);

    const d = dom.window.document;
    const btn = d.getElementById("jn-buy");
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 900));

    const url = urls[0] || "";
    const m = /client_reference_id=([^&]*)/.exec(url);
    const ref = m ? decodeURIComponent(m[1]) : "";
    const names = events.filter((e) => /^checkout/.test(e[0]));
    const terms = ((d.getElementById("jn-terms") || {}).textContent || "").replace(/\s+/g, " ").trim();

    say("  · " + label);
    say("      events   : " + JSON.stringify(names));
    say("      URL      : " + (url || "(none — no checkout was started)"));
    say("      ref      : " + (ref || "(none)"));

    if (wantRef === "") {
      line(!url && names.some((e) => e[0] === "checkout_blocked" && e[1].why === "no_uid"),
           "signed out: no Stripe URL is built at all, and it is counted");
    } else if (wantRef.length > 3) {
      line(ref === wantRef && names.some((e) => e[0] === "checkout_start" && e[1].attributed === "1"),
           "signed in: the Firebase uid rides on the URL, attributed 1");
    } else {
      line(ref.indexOf("fba") === 0 && ref.length < 28 &&
           names.some((e) => e[0] === "checkout_start" && e[1].attributed === "0"),
           "auth unavailable: the sale is allowed through on the LOCAL id, attributed 0",
           "and part 1 proves the webhook refuses to make a customers/ row out of it");
    }
    if (label === "signed in") {
      line(/US\$35\.88 a year/.test(terms) && /US\$2\.99 a month/.test(terms),
           "the terms line quotes Stripe's own 3588, from FBA and nothing else",
           terms.slice(0, 130));
    }
  }
}

async function partRevocation() {
  say("\n3  revocation reaching the reader  ·  a story page, not Firestore\n");

  const FBU = stubFBU({ known: true, signedIn: true, premium: true,
                        uid: "woJ4di0ze9XkQ2rTb8mNpLcVaH3f", email: "hassan@example.com" });
  const { dom, errors } = await load(BASE + "/read?s=03", (w) => { w.FBU = FBU; }, 4500);
  const w = dom.window;
  line(w.FBX.can() === true && w.FBX.why() === "subscriber",
       "a subscriber opens the paid story 03 and reads it",
       "why=" + w.FBX.why() + "  paywalls=" + w.document.querySelectorAll(".paywall").length);

  errors.length = 0;
  FBU.__state.premium = false;                       /* the webhook wrote false */
  FBU.__premFns.forEach((f) => { try { f(false); } catch (e) {} });
  await new Promise((r) => setTimeout(r, 800));

  line(w.FBX.can() === false && w.FBX.why() === "none",
       "js/access.js flips to none the moment the snapshot lands");
  line(errors.some((e) => /navigation to another Document/.test(e)),
       "AND THE PAGE REDRAWS: FBX.correct(true) reloads it",
       "jsdom cannot navigate, so the reload surfaces as " + JSON.stringify(errors));

  const out = stubFBU({ known: true, signedIn: false, premium: false });
  const free = await load(BASE + "/read?s=01", (w2) => { w2.FBU = out; }, 4500);
  const fd = free.dom.window.document;
  line(!free.errors.some((e) => /navigation to another Document/.test(e)) &&
       (fd.body.textContent || "").trim().length > 500,
       "a signed-out reader on the FREE story 01 is not reloaded out from under",
       (fd.body.textContent || "").trim().length + " characters on screen, no reload");
}

/* -------------------------------------------------------------------------- */
(async () => {
  await partWebhook();
  if (!JSDOM) {
    say("\n2, 3  skipped: jsdom not installed (npm i --prefix tools jsdom)\n");
  } else {
    let up = false;
    /* The body has to be drained, not just checked: an undici response left
       open takes the process down when the socket closes under it. */
    try { const probe = await fetch(BASE + "/join"); up = probe.ok; await probe.text(); } catch (e) {}
    if (!up) {
      say("\n2, 3  skipped: nothing is serving " + BASE +
                  "\n      python3 tools/serve-like-pages.py 8899 .\n");
    } else {
      await partCheckout();
      await partRevocation();
    }
  }
  say("\n" + (pass + fail) + " checks on the money path, " + fail + " broken\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { say("harness error: " + (e && e.stack)); process.exit(1); });
