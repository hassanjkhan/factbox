#!/usr/bin/env node
/* ==========================================================================
   Factbox — mint single-use promo codes for the comment→DM campaign.

   Kathryn posts a reel: "comment HISTORY and I'll DM you a week free."
   ManyChat DMs each commenter a link carrying a code minted here. This writes
   N codes to `promo_codes/{CODE}` in Firestore and prints them one per line,
   so the list can be pasted straight into ManyChat's randomiser.

   Usage:
     node tools/mint-promo-codes.js --count 200 --campaign history-reel
     node tools/mint-promo-codes.js -n 5 -c smoke-test --days 30
     node tools/mint-promo-codes.js -n 5 -c smoke-test --dry-run
     node tools/mint-promo-codes.js -n 5 -c smoke-test --links   (full URLs)

   Flags:
     --count / -n     how many codes            (required, 1..5000)
     --campaign / -c  what they were minted for (required)
     --days           how many days the CODE stays live before expiring
                      (default 30). NOT the trial length — see below.
     --trial-days     the trial each code grants. Default 7, and there is
                      almost never a reason to pass it: functions/promo.js
                      REFUSES any other value, so a code minted with a
                      different number validates as `unknown`. The flag
                      exists so that changing the campaign length is a
                      deliberate three-file edit rather than an accident.
     --links          print /join?code=… URLs instead of bare codes
     --dry-run        generate and print, write nothing

   ---------------------------------------------------------------------------
   WHY A SERVICE-ACCOUNT KEY HERE AND NOT THE CLI TOKEN seed-firebase.js USES

   seed-firebase.js writes with the OAuth token `firebase login` already holds,
   and its header explains why it does not want a downloaded key: a key file is
   a permanent credential sitting on a laptop. That reasoning has not changed,
   and this file does not weaken it — the key at ~/.factbox-keys/admin.json is
   OUTSIDE the repository, is never read from anywhere inside it, and .gitignore
   is not what is keeping it out of git; its directory is.

   What this needs that seeding does not is a TRANSACTION and a `create()` that
   fails on collision, so a mint run cannot overwrite a code somebody is
   holding. That is the Admin SDK, and the Admin SDK wants credentials.

   THE KEY IS A SECRET AND MUST NEVER ENTER THIS REPO, a commit message, or a
   chat log — the same rule STRIPE.md sets for the Stripe API key. If you need
   one, ask Hassan.
   ---------------------------------------------------------------------------

   WHAT A CODE IS NOT. A code never grants access to anything. It changes which
   Stripe Payment Link a reader is sent to, so their trial is seven days rather
   than three. `customers/{uid}.premium` is written by the Stripe webhook and
   by nothing else in this repository. Minting ten thousand codes gives away
   ten thousand longer TRIALS, not ten thousand subscriptions.
   ========================================================================== */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PROJECT = "factbox-7cb97";
const COLLECTION = "promo_codes";
const KEY_PATH = path.join(os.homedir(), ".factbox-keys", "admin.json");
const SITE = "https://factbox.app/join";

/* ==========================================================================
   THE ALPHABET, AND WHY THESE 28 SYMBOLS.

   MUST MATCH functions/promo.js exactly. A minter and a validator that
   disagree about the alphabet mint codes that never validate.

   Every vowel is gone (A, E, I, O, U) and so is L. That does two jobs:

     1. CONFUSABLES. O against 0, and I against 1 against l, are the pairs
        that break a code read off a phone screen or retyped from a DM. Both
        members of each pair are removed, so there is nothing to map on input
        and no chance of mapping it the wrong way — a reader cannot mistype a
        zero for an O in a code that contains neither.
     2. NO ACCIDENTAL WORDS. A campaign is thousands of random strings. With
        vowels in the alphabet, one of them eventually spells something the
        brand has to answer for in somebody's DMs. Without vowels, none can.

   S/5 and Z/2 survive, and that is a priced trade rather than an oversight:
   these codes are CLICKED from a DM, not dictated down a phone, and dropping
   four more symbols would cost entropy to cover a case that barely arises.

   LENGTH: 12 symbols, printed in three hyphenated groups of four. 28^12 is
   about 2.3e17, or 57.7 bits.

   IT IS 12 BECAUSE SEQUENTIAL OR SHORT IS THE WHOLE ATTACK. A sequential code
   means one person with a for-loop drains the campaign in an afternoon; a
   short random one means the same person does it with a slightly longer loop.
   At 57.7 bits, guessing one live code out of a 5,000-code campaign takes
   about 4.6e13 tries — and functions/promo.js allows 60 a minute per address,
   which puts that at roughly a billion years. The entropy is the defence; the
   rate limit is a courtesy to the bill.
   ========================================================================== */
const ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
const CODE_LEN = 12;
const GROUP = 4;

/* MUST EQUAL `PROMO_TRIAL_DAYS` in functions/promo.js and `PROMO.trialDays`
   in js/account.js, and must equal the trial_period_days on the promotional
   Stripe Payment Links. tools/check-regressions.js asserts the first three
   agree; Stripe's own setting is checked by loading the link. */
const TRIAL_DAYS = 7;

/* How long a minted code stays live. A campaign that never expires is a
   discount somebody finds in a screenshot two years later. */
const DEFAULT_LIFE_DAYS = 30;

/* ------------------------------------------------------------------ random

   crypto.randomBytes, and rejection sampling rather than a modulo.

   256 is not a multiple of 28, so `byte % 28` would make the first four
   symbols of the alphabet about 12% likelier than the rest. That is not a
   theoretical complaint: biased symbols are how a "random" code space quietly
   shrinks, and the entropy above is the entire defence of this campaign.
   Bytes at or above the largest multiple of 28 are thrown away instead. */
function randomCode() {
  const limit = 256 - (256 % ALPHABET.length);   /* 252 */
  let out = "";
  while (out.length < CODE_LEN) {
    const buf = crypto.randomBytes(CODE_LEN * 2);
    for (let i = 0; i < buf.length && out.length < CODE_LEN; i++) {
      if (buf[i] >= limit) continue;             /* biased tail, discarded */
      out += ALPHABET[buf[i] % ALPHABET.length];
    }
  }
  return out;
}

/* The document id is the BARE code. The hyphens are punctuation for a human
   eye — functions/promo.js strips them on the way in — so they must not be
   part of what is stored, or a reader who retypes it without them misses. */
function pretty(code) {
  const parts = [];
  for (let i = 0; i < code.length; i += GROUP) parts.push(code.slice(i, i + GROUP));
  return parts.join("-");
}

/* ------------------------------------------------------------------- args */

function arg(names, fallback) {
  const a = process.argv.slice(2);
  for (const n of names) {
    const i = a.indexOf(n);
    if (i !== -1 && a[i + 1] !== undefined) return a[i + 1];
  }
  return fallback;
}
function flag(names) {
  const a = process.argv.slice(2);
  return names.some((n) => a.indexOf(n) !== -1);
}

function die(msg) {
  process.stderr.write("mint-promo-codes: " + msg + "\n");
  process.exit(1);
}

/* ------------------------------------------------------------------- main */

async function main() {
  const count = Number(arg(["--count", "-n"], ""));
  const campaign = String(arg(["--campaign", "-c"], "")).trim();
  const lifeDays = Number(arg(["--days"], String(DEFAULT_LIFE_DAYS)));
  const trialDays = Number(arg(["--trial-days"], String(TRIAL_DAYS)));
  const DRY = flag(["--dry-run"]);
  const LINKS = flag(["--links"]);

  if (!isFinite(count) || count < 1 || count > 5000) {
    die("--count must be 1..5000 (got " + JSON.stringify(arg(["--count", "-n"], "")) + ")");
  }
  /* The campaign name is a join key: it is what ManyChat's flow is called and
     what the logs and the Firestore rows are grouped by. Kept to the shape a
     document field and a log line can both carry without quoting. */
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(campaign)) {
    die("--campaign must be 2..40 chars of lower-case letters, digits and dashes");
  }
  if (!isFinite(lifeDays) || lifeDays < 1 || lifeDays > 365) {
    die("--days must be 1..365");
  }
  if (trialDays !== TRIAL_DAYS) {
    /* Loud, and it still proceeds, because there is one legitimate use: a
       deliberate campaign-length change, made in all three files at once. */
    process.stderr.write(
      "mint-promo-codes: WARNING — minting " + trialDays + "-day codes while " +
      "this build's promo trial is " + TRIAL_DAYS + " days.\n" +
      "  functions/promo.js will report these as `unknown` and every reader " +
      "will silently get the STANDARD trial.\n" +
      "  To change the campaign length, change it in all three places at once: " +
      "PROMO_TRIAL_DAYS in functions/promo.js, PROMO.trialDays in " +
      "js/account.js, and the trial_period_days on the Stripe Payment Links.\n");
  }

  /* --- credentials --- */
  if (!fs.existsSync(KEY_PATH)) {
    die("no service-account key at " + KEY_PATH + " — ask Hassan for one. " +
        "It lives outside the repo and must never be committed.");
  }
  let key;
  try { key = JSON.parse(fs.readFileSync(KEY_PATH, "utf8")); }
  catch (e) { die("could not read " + KEY_PATH + ": " + e.message); }
  if (!key || key.project_id !== PROJECT) {
    die("that key is for project " + JSON.stringify(key && key.project_id) +
        ", not " + PROJECT);
  }

  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(key), projectId: PROJECT });
  }
  const db = admin.firestore();

  /* --- generate, de-duplicated in memory first ---
     A collision at 57.7 bits is not going to happen, and the set is here
     anyway: it costs nothing and it is the difference between "we believe it
     cannot collide" and "it did not". The create() below is the real guard —
     it fails rather than overwriting a code somebody is already holding. */
  const wanted = new Set();
  let spins = 0;
  while (wanted.size < count) {
    wanted.add(randomCode());
    if (++spins > count * 50) die("could not generate enough distinct codes");
  }
  const codes = [...wanted];

  const now = Date.now();
  const expiresAt = new Date(now + lifeDays * 86400000);
  /* One id per RUN, so every code from one mint can be found together — which
     ManyChat flow got which batch, and which batch to expire if a link leaks.
     This is the field the DM tool correlates on. */
  const batch = campaign + "-" + new Date(now).toISOString().slice(0, 10) + "-" +
                crypto.randomBytes(3).toString("hex");

  if (DRY) {
    process.stderr.write("dry run: nothing written. batch would be " + batch + "\n");
    for (const c of codes) console.log(LINKS ? SITE + "?code=" + pretty(c) : pretty(c));
    return;
  }

  /* --- write ---
     `create()`, never `set()`. set() would silently overwrite a live code — a
     reader's week, gone, and no trace of it. create() throws on collision, and
     a mint run that throws is a mint run somebody looks at.

     Batched 400 at a time, under Firestore's 500-operation limit. */
  let written = 0;
  for (let i = 0; i < codes.length; i += 400) {
    const chunk = codes.slice(i, i + 400);
    const wb = db.batch();
    for (const c of chunk) {
      wb.create(db.collection(COLLECTION).doc(c), {
        /* The code, as its own field as well as the document id. The id is
           what makes validate a single get; the field is what makes the row
           readable in the console and exportable without reading ids. */
        code: c,
        /* What it grants. Read and CLAMPED by functions/promo.js: a value
           other than its PROMO_TRIAL_DAYS validates as `unknown`, so a
           mis-minted batch can never put a month of free copy on a screen
           backed by a week-long Payment Link. */
        trialDays: trialDays,
        /* Which campaign, and which run of it. The two join keys ManyChat
           and the reel report are grouped by. */
        campaign: campaign,
        batch: batch,
        /* The URL that goes in the DM, stored beside the code so the row is
           self-explanatory to whoever opens it in the console in six months. */
        link: SITE + "?code=" + pretty(c),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        /* Single use. functions/promo.js sets these, in a transaction, at the
           moment a checkout actually starts — never on validate, because a
           reader may open their DM link twice. */
        usedAt: null,
        usedByUid: null
      });
    }
    await wb.commit();
    written += chunk.length;
  }

  /* Everything a person needs goes to stderr; stdout is ONLY codes, one per
     line, so `node tools/mint-promo-codes.js … > codes.txt` produces a file
     that pastes straight into ManyChat with nothing to strip. */
  process.stderr.write(
    written + " codes written to " + COLLECTION + "/ — campaign " + campaign +
    ", batch " + batch + ", " + trialDays + "-day trial, expiring " +
    expiresAt.toISOString().slice(0, 10) + "\n");

  for (const c of codes) console.log(LINKS ? SITE + "?code=" + pretty(c) : pretty(c));
}

main().then(() => process.exit(0), (err) => die(err && err.stack || String(err)));
