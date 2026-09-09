#!/usr/bin/env node
/* ==========================================================================
   Factbox — put a real history, and the outstanding work, on the shared
   task board.

   `admin_tasks` and `admin_goals` are the two collections behind
   admin/tasks.html and js/admin-tasks.js: the board Hassan and Kathryn both
   edit, live. This fills it. It exists for one reason and it is not
   convenience — a board that opens EMPTY teaches the two people looking at
   it that the board is somewhere work goes to be forgotten, and they stop
   opening it in a week. So the first thing it shows is the 120-odd things
   that are already DONE, one per commit, on the real day each one landed.
   That is not decoration; it is the only part of the board nobody has to be
   trusted to have typed honestly.

   WHAT IT WRITES

     admin_tasks/c-<full sha>    one commit, status "done", doneAt and
                                 createdAt set to the commit's author date,
                                 title from the commit subject, area "code",
                                 owner "hassan"
     admin_tasks/k-<key>         a task from --file, keyed on whatever the
                                 JSON called it
     admin_goals/kg-<key>        a goal from --file

   IDEMPOTENT, AND THE KEY IS THE DOCUMENT ID. Re-running writes nothing:
   the sha IS the id, so the second run finds every document already there
   and creates none. It uses create() rather than set(), so even if the
   existence check raced somebody typing on the board, the write fails with
   ALREADY_EXISTS and is counted as skipped rather than overwriting an edit.
   An existing row is NEVER updated by this tool. Once a task is on the
   board it belongs to whoever is looking at the board, and a seeder that
   reasserted its own idea of the title every run would silently undo them.

   WHY THE ID AND NOT A `sha` FIELD. firestore.rules enumerates the eleven
   keys a task may have and one unlisted key denies the whole write — and on
   an update `request.resource.data` is the document AFTER the merge, so a
   twelfth field written here would not sit there harmlessly: it would make
   every later edit from the browser fail with permission-denied, on rows
   that look perfectly normal. The id carries the key instead, and everything
   this tool writes is a shape the browser can go on editing.

   CREDENTIALS. The service-account key at ~/.factbox-keys/admin.json, the
   same one tools/mint-promo-codes.js uses, loaded the same way. (Unlike
   tools/seed-firebase.js, which talks to the REST API with the Firebase
   CLI's own OAuth token, this one uses firebase-admin — it is writing 120
   documents with server timestamps and batching, which the admin SDK does
   in one line and hand-rolled REST does in forty.) The key lives outside
   the repo and must never be committed. The admin SDK bypasses
   firestore.rules entirely, which is why every row below is validated here
   against the same enums and lengths the rules enforce: a row this tool
   waves through that the rules would refuse is a row the board can display
   and never edit.

   Usage:
     node tools/seed-tasks.js                          commits only
     node tools/seed-tasks.js --file work.json         commits + that file
     node tools/seed-tasks.js --file work.json --dry-run
     node tools/seed-tasks.js --no-commits --file work.json
     node tools/seed-tasks.js --max 40                 the 40 newest commits

   The JSON is either a bare array of tasks, or:
     { "tasks": [ {...}, ... ], "goals": [ {...}, ... ] }
   Each row wants a stable "key" (used for the document id); without one the
   title is hashed, which means renaming the task re-seeds it as a new row.
   ========================================================================== */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const PROJECT = "factbox-7cb97";
const ROOT = path.resolve(__dirname, "..");
const KEY_PATH = path.join(os.homedir(), ".factbox-keys", "admin.json");

const TASKS = "admin_tasks";
const GOALS = "admin_goals";

/* The same three lists js/admin-tasks.js exposes and firestore.rules
   enforces. If these ever disagree, the rules are the ones that decide. */
const OWNERS        = ["hassan", "kathryn", "either"];
const PRIORITIES    = ["high", "low"];
const STATUSES      = ["todo", "doing", "done"];
const GOAL_STATUSES = ["open", "hit", "missed"];

const MAX_TITLE = 120, MAX_DETAIL = 600, MAX_AREA = 40, MAX_TARGET = 40;

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.indexOf(f) !== -1;
const val = (f, d) => { const i = ARGS.indexOf(f); return i === -1 ? d : ARGS[i + 1]; };
const DRY = has("--dry-run");
const NO_COMMITS = has("--no-commits");
const FILE = val("--file", "");
const MAX = Number(val("--max", "0")) || 0;

function die(msg) { console.error("\n  " + msg + "\n"); process.exit(1); }

/* ------------------------------------------------------------------ shapes */

function clip(v, n) {
  let s = (v == null ? "" : String(v)).replace(/\s+/g, " ").trim();
  if (s.length > n) s = s.slice(0, n - 3).trim() + "...";
  return s;
}
function pick(v, list, fallback, what) {
  const s = String(v == null ? "" : v).toLowerCase();
  if (!s) return fallback;
  if (list.indexOf(s) === -1) {
    die(`"${s}" is not a valid ${what}. The rules only accept: ${list.join(", ")}`);
  }
  return s;
}
/* A document id, not a field: [A-Za-z0-9._-], never empty, never "." or
   "..", never __surrounded__. */
function idPart(s) {
  const out = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 60);
  return out || crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 16);
}
function keyFor(row) {
  if (row.key) return idPart(row.key);
  return crypto.createHash("sha1").update(String(row.title || "")).digest("hex").slice(0, 20);
}

/* ------------------------------------------------------------------- input */

function commits() {
  if (NO_COMMITS) return [];
  let out = "";
  try {
    /* %H sha, %aI author date (the day the work happened, not the day it was
       rebased), %s subject. Merges are skipped: "Merge branch 'x'" is not a
       thing anybody did. \x1f between fields because a commit subject can
       contain anything except a newline. */
    out = execFileSync("git", ["log", "--no-merges", "--pretty=format:%H\x1f%aI\x1f%s"],
                       { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    die("could not read git log from " + ROOT + ": " + e.message);
  }
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [sha, iso, subject] = line.split("\x1f");
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const when = new Date(iso);
    if (isNaN(when.getTime())) continue;
    const title = clip(subject, MAX_TITLE);
    if (!title) continue;
    rows.push({ sha, when, title });
  }
  return MAX ? rows.slice(0, MAX) : rows;
}

function fileRows() {
  if (!FILE) return { tasks: [], goals: [] };
  const p = path.isAbsolute(FILE) ? FILE : path.join(process.cwd(), FILE);
  if (!fs.existsSync(p)) die("no such file: " + p);
  let j;
  try { j = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { die("could not parse " + p + ": " + e.message); }
  if (Array.isArray(j)) return { tasks: j, goals: [] };
  return { tasks: j.tasks || [], goals: j.goals || [] };
}

/* ---------------------------------------------------------------- payloads */

function taskFromCommit(c, admin) {
  const at = admin.firestore.Timestamp.fromDate(c.when);
  return {
    id: "c-" + c.sha,
    data: {
      title: c.title,
      /* The short sha is in the detail rather than in a field of its own,
         for the reason at the top of this file: a twelfth key would lock
         the row against every later edit from the browser. */
      detail: "commit " + c.sha.slice(0, 10) + " · " + c.when.toISOString().slice(0, 10),
      owner: "hassan",
      priority: "low",
      status: "done",
      area: "code",
      /* Chronological, so the done column reads like a history. */
      order: c.when.getTime(),
      createdAt: at,
      updatedAt: at,
      doneAt: at,
      updatedBy: "seed"
    }
  };
}

function taskFromFile(row, i, admin, now) {
  const title = clip(row.title, MAX_TITLE);
  if (!title) die(`task #${i + 1} in --file has no title`);
  const status = pick(row.status, STATUSES, "todo", "status");
  const when = row.at ? new Date(row.at) : null;
  const at = (when && !isNaN(when.getTime()))
    ? admin.firestore.Timestamp.fromDate(when) : now;
  return {
    id: "k-" + keyFor({ key: row.key, title }),
    data: {
      title,
      detail: clip(row.detail, MAX_DETAIL),
      owner: pick(row.owner, OWNERS, "either", "owner"),
      priority: pick(row.priority, PRIORITIES, "low", "priority"),
      status,
      area: clip(row.area, MAX_AREA),
      order: typeof row.order === "number" && isFinite(row.order) ? row.order : (i + 1),
      createdAt: at,
      updatedAt: at,
      doneAt: status === "done" ? at : null,
      updatedBy: "seed"
    }
  };
}

function goalFromFile(row, i, admin, now) {
  const title = clip(row.title, MAX_TITLE);
  if (!title) die(`goal #${i + 1} in --file has no title`);
  return {
    id: "kg-" + keyFor({ key: row.key, title }),
    data: {
      title,
      detail: clip(row.detail, MAX_DETAIL),
      target: clip(row.target, MAX_TARGET),
      status: pick(row.status, GOAL_STATUSES, "open", "goal status"),
      order: typeof row.order === "number" && isFinite(row.order) ? row.order : (i + 1),
      createdAt: now,
      updatedAt: now,
      updatedBy: "seed"
    }
  };
}

/* ------------------------------------------------------------------- write */

async function writeAll(db, coll, rows) {
  if (!rows.length) return { created: 0, skipped: 0, wouldCreate: 0 };
  const col = db.collection(coll);

  /* Ask first, so the report can say what it did rather than what it tried.
     getAll takes up to 300 refs at a time. */
  const existing = new Set();
  for (let i = 0; i < rows.length; i += 250) {
    const chunk = rows.slice(i, i + 250);
    const snaps = await db.getAll(...chunk.map((r) => col.doc(r.id)));
    snaps.forEach((s) => { if (s.exists) existing.add(s.id); });
  }
  const missing = rows.filter((r) => !existing.has(r.id));

  if (DRY) {
    return { created: 0, skipped: existing.size, wouldCreate: missing.length };
  }

  /* create(), not set(): if the existence check above raced somebody adding
     a row on the board, this fails loudly for that one document instead of
     overwriting what they typed. */
  let created = 0, raced = 0;
  for (let i = 0; i < missing.length; i += 25) {
    const chunk = missing.slice(i, i + 25);
    const results = await Promise.all(chunk.map((r) =>
      col.doc(r.id).create(r.data).then(() => "created", (e) => {
        /* gRPC status 6 is ALREADY_EXISTS: somebody added this row on the
           board between the check above and now. Not an error — the whole
           point of keying on the id is that the row is already right. */
        const already = e && (e.code === 6 || String(e.code) === "6" ||
                              /ALREADY_EXISTS|already exists/i.test(String(e.message || "")));
        if (already) return "raced";
        throw e;
      })
    ));
    results.forEach((x) => { if (x === "created") created++; else raced++; });
  }
  return { created, skipped: existing.size + raced };
}

async function count(db, coll) {
  try {
    const snap = await db.collection(coll).count().get();
    return snap.data().count;
  } catch (e) {
    const s = await db.collection(coll).select().get();
    return s.size;
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!fs.existsSync(KEY_PATH)) {
    die("no service-account key at " + KEY_PATH + " — ask Hassan for one. " +
        "It lives outside the repo and must never be committed.");
  }
  let key;
  try { key = JSON.parse(fs.readFileSync(KEY_PATH, "utf8")); }
  catch (e) { die("could not read " + KEY_PATH + ": " + e.message); }
  if (!key || key.project_id !== PROJECT) {
    die("that key is for project " + JSON.stringify(key && key.project_id) + ", not " + PROJECT);
  }

  const admin = require("firebase-admin");   // resolves from tools/node_modules
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(key), projectId: PROJECT });
  }
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  const cs = commits();
  const extra = fileRows();

  const taskRows = cs.map((c) => taskFromCommit(c, admin))
    .concat(extra.tasks.map((r, i) => taskFromFile(r, i, admin, now)));
  const goalRows = extra.goals.map((r, i) => goalFromFile(r, i, admin, now));

  /* Two rows with the same key would make the second silently a no-op. Say
     so instead. */
  const seen = new Set();
  for (const r of taskRows.concat(goalRows)) {
    if (seen.has(r.id)) die("two rows share the id " + r.id + " — give them distinct \"key\" values");
    seen.add(r.id);
  }

  console.log(`\n  project   ${PROJECT}${DRY ? "   (DRY RUN — nothing is written)" : ""}`);
  console.log(`  commits   ${cs.length}${NO_COMMITS ? "  (--no-commits)" : ""}`);
  console.log(`  from file ${extra.tasks.length} task(s), ${extra.goals.length} goal(s)` +
              (FILE ? "  <- " + FILE : "  (no --file)"));

  const t = await writeAll(db, TASKS, taskRows);
  const g = await writeAll(db, GOALS, goalRows);

  console.log(`\n  ${TASKS}   created ${DRY ? t.wouldCreate + " (would)" : t.created}, ` +
              `already there ${t.skipped}`);
  console.log(`  ${GOALS}   created ${DRY ? g.wouldCreate + " (would)" : g.created}, ` +
              `already there ${g.skipped}`);
  console.log(`\n  now in ${TASKS}: ${await count(db, TASKS)}` +
              `      now in ${GOALS}: ${await count(db, GOALS)}\n`);
}

main().then(() => process.exit(0), (e) => {
  console.error("\n  FAILED: " + (e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});
