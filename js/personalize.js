/* ==========================================================================
   Factbox — personalization. What the quiz answers are allowed to do.

   One global, FBFIT. It answers exactly one question: given the genres a
   reader ticked in onboarding, in what order should the fifty-one stories be
   offered to them? It does not fetch, does not write storage, does not touch
   the DOM, and contains no randomness. Same input, same output, forever.

   ---------------------------------------------------------------------------
   WHY THIS IS NOT CALLED FBP

   The brief asked for the global to be FBP. FBP is already taken: it is
   js/progress.js, "paid-access persistence and reading memory", and it is
   loaded on every page of the site. js/gate.js, js/owner.js, js/analytics.js,
   js/saves.js, js/recommend.js and account.html all read it, and two of them
   decide whether a paying reader sees a paywall. A second `var FBP` in this
   file would silently clobber it and lock out buyers. So this is FBFIT —
   "does this story fit what you picked" — and it follows the same convention
   as js/access.js: one IIFE, one global, ES5 only, no dependencies.

   ES5 ONLY. This ships into Instagram and TikTok in-app webviews. No arrow
   functions, no const/let, no template literals, no Object.assign, no spread,
   no Array.prototype.includes/find. If you cannot write it for IE11, do not
   write it here.

   ---------------------------------------------------------------------------
   THE PROBLEM THIS FILE EXISTS TO SOLVE

   The mockup's six genres pointed at sixteen distinct stories out of fifty-one.
   "Religion & mythology" pointed at two. Meanwhile the catalogue is 57%
   biblical:

     church_history 11   new_testament 11   old_testament 7   = 29 of 51
     cleopatra       8   medieval_modern 5  us_history    4
     ancient_world   4   disaster        1

   So the funnel had two failures stacked on top of each other. It promised
   personalization it could not deliver (2 stories for a whole genre), and the
   genre that mattered most to the actual shelf was the one the reader is
   least likely to tick. A reader who picks "Scandals" and "Mysteries" is
   still going to be handed a majority-biblical library, because that is what
   the library is.

   THE TENSION, AND HOW IT IS RESOLVED HERE

   Two bad answers were available:

     Silo it.  Keep one genre called "Religion & mythology". Readers who do
               not tick it are then promised a feed built from the 43% that is
               left, and the promise breaks on day four when they run out.
     Hide it.  Drop the religious framing entirely and let biblical stories
               arrive under neutral labels. That is a bait-and-switch: the
               reader thinks they bought ancient scandal and gets the New
               Testament.

   The resolution is that most biblical stories are not religious stories in
   the way a reader means it. "Mary Magdalene wasn't a prostitute" is a myth
   correction. "Where was the Garden of Eden?" is a lost-place mystery. "Why
   did they actually kill Jesus?" is political murder. The subject is biblical;
   the SHAPE is the thing the reader picked. So:

     1. Genres are cut by narrative shape as much as by subject, and every
        biblical story that has a mainstream door is put through it. A reader
        who ticks "Myths everyone gets wrong" and receives Mary Magdalene got
        precisely what they asked for.
     2. Exactly nine of the twenty-nine biblical stories have no mainstream
        door — they are devotional or exegetical first (see PRIMARY_FAITH,
        computed, not hand-listed). Those nine are the honest content of the
        "The Bible, honestly" genre and they are ranked DOWN, not hidden, for
        anyone who did not ask.
     3. Because the arithmetic still cannot make 29 into a minority, the
        funnel says so out loud, once, in one line under the genre grid.
        disclosure() is that line. It is not optional garnish. It is the thing
        that keeps this from being a bait-and-switch, and it is in this file
        so it cannot be quietly deleted from a template.
     4. spread() stops the first screen of a non-religious reader's feed from
        being an unbroken run of scripture even when the scores say it should
        be. Never more than two in a row in the opening twelve.

   ---------------------------------------------------------------------------
   WHAT CHANGED FROM THE MOCKUP'S SIX LABELS, AND WHY

   Four kept as-is or widened: scandal, power, mystery, war.

     "Famous lives"          ->  "Myths everyone gets wrong"
        Famous lives matched 45 of 51 stories. Every story here is a famous
        life. A genre that matches almost everything is not a preference, it
        is noise, and it cannot rank. myth_correction is the largest single
        narrative kind in the catalogue (11) and the house voice: "Napoleon
        wasn't short", "Satan isn't God's rival", "Nero didn't fiddle". It
        discriminates, and it is the main vehicle carrying biblical stories to
        readers who did not tick the Bible.

     "Religion & mythology"  ->  "The Bible, honestly"
        There is no mythology in this catalogue. No Greek, no Norse, no
        Egyptian myth — the Egyptian material is Ptolemaic politics. The label
        promised a breadth that does not exist. "The Bible, honestly" names
        the treatment rather than the faith: these are evidence-first
        corrections, not devotion, which is what both the curious sceptic and
        the churchgoer are actually here for.

     "Ancient scandals"      ->  "Scandal & desire"
        The scandal is not all ancient. Rasputin and Lincoln are in it.
   ========================================================================== */

var FBFIT = (function () {
  "use strict";

  var VERSION = "1.0.0";

  /* ------------------------------------------------------------------ *
   * The vocabulary. Six genres, reader-facing labels, stable keys.
   * `key` is what gets stored in the answers object and in analytics.
   * Order here is the order of the grid in onboarding.
   * ------------------------------------------------------------------ */
  var GENRES = [
    { key: "scandal", label: "Scandal & desire",
      blurb: "Affairs, rumours and reputations that outlived the people in them.",
      cover: "19" },
    { key: "power", label: "Power & betrayal",
      blurb: "Who took it, who lost it, and who was stabbed for it.",
      cover: "50" },
    { key: "mystery", label: "Unsolved mysteries",
      blurb: "Bodies never found, tombs never opened, questions still open.",
      cover: "17" },
    { key: "war", label: "Wars & empires",
      blurb: "Conquests, sieges and the empires that did not outlive their founder.",
      cover: "31" },
    { key: "myths", label: "Myths everyone gets wrong",
      blurb: "The version you were taught, and the version the evidence supports.",
      cover: "39" },
    { key: "bible", label: "The Bible, honestly",
      blurb: "What the text actually says, without the sermon.",
      cover: "23" }
  ];

  /* ------------------------------------------------------------------ *
   * The map. All 51 stories. Weight 3 = this is what the story IS,
   * 2 = strong secondary read, 1 = fair to surface on this pick.
   * Every id appears at least once; most appear two or three times.
   * Weights, not sets — a set cannot rank, and ranking is the job.
   * ------------------------------------------------------------------ */
  var MAP = {
    "01":  { mystery: 3, scandal: 1, power: 1 },
    "02":  { scandal: 3, myths: 3, power: 1 },
    "03":  { mystery: 3, scandal: 1 },
    "04":  { bible: 3, scandal: 2 },
    "05":  { bible: 3, mystery: 3 },
    "06":  { bible: 3, mystery: 2, scandal: 2 },
    "07":  { power: 2, myths: 2, war: 1 },
    "07B": { scandal: 3, bible: 3, power: 2 },
    "08":  { power: 3, mystery: 1, war: 1 },
    "09":  { mystery: 2, power: 2, myths: 1 },
    "10":  { bible: 3, power: 2, war: 1 },
    "11":  { bible: 3, power: 2 },
    "12":  { myths: 3, bible: 3 },
    "13":  { myths: 3, bible: 3 },
    "14":  { bible: 3, mystery: 2 },
    "15":  { war: 3, power: 3, bible: 2 },
    "16":  { mystery: 3, bible: 3 },
    "17":  { mystery: 3, power: 1 },
    "18":  { mystery: 3, power: 1 },
    "19":  { scandal: 3, power: 2 },
    "20":  { scandal: 3, power: 3, war: 2 },
    "21":  { power: 3, myths: 1 },
    "22":  { bible: 3 },
    "23":  { myths: 3, scandal: 3, bible: 3 },
    "24":  { power: 3, bible: 3, myths: 2 },
    "25":  { mystery: 3, bible: 3 },
    "26":  { bible: 3, mystery: 2, myths: 1 },
    "27":  { power: 3, scandal: 2, war: 1 },
    "28":  { power: 3, mystery: 2, war: 1, scandal: 1 },
    "29":  { power: 3, bible: 3, scandal: 1 },
    "30":  { myths: 3, bible: 3, power: 2 },
    "31":  { mystery: 3, war: 3, power: 2 },
    "32":  { war: 3, power: 2, scandal: 1 },
    "33":  { myths: 3, bible: 3 },
    "34":  { myths: 3, bible: 3 },
    "35":  { bible: 3, myths: 2, scandal: 1 },
    "36":  { mystery: 3, bible: 3, power: 2 },
    "37":  { bible: 3, mystery: 3 },
    "38":  { mystery: 3, war: 3, power: 1 },
    "39":  { myths: 3, war: 3, power: 1 },
    "40":  { war: 3, power: 2, myths: 1 },
    "41":  { myths: 3, power: 2, scandal: 2, war: 1 },
    "42":  { power: 3, bible: 3, war: 2 },
    "43":  { myths: 3, scandal: 3, power: 2 },
    "44":  { mystery: 3, war: 3, power: 2 },
    "45":  { mystery: 3, bible: 3 },
    "46":  { mystery: 3, bible: 3 },
    "47":  { bible: 3, myths: 2 },
    "48":  { bible: 3, mystery: 3, power: 2 },
    "49":  { myths: 3, bible: 3 },
    "50":  { power: 3, war: 3, mystery: 1 }
  };

  /* Canonical id order. The tie-break of last resort, and the fallback
     catalogue when nobody hands us index.json. "07" < "07B" < "08" under
     ordinary string comparison, which is the only reason 07B is safe. */
  var IDS = (function () {
    var out = [], k;
    for (k in MAP) { if (MAP.hasOwnProperty(k)) out.push(k); }
    out.sort();
    return out;
  })();

  /* ------------------------------------------------------------------ *
   * Ranking constants. All integers on purpose: floats make ties
   * depend on IEEE rounding, and ties here must be broken by the rules
   * below, not by the arithmetic.
   * ------------------------------------------------------------------ */

  /* Tap order in the grid is a real but weak signal. First pick counts
     half again as much as the third; it never swamps a strong match. */
  var PICK_MULT = [6, 5, 4];
  var MAX_PICKS = 3;

  /* How far into the feed the religious-spread rule applies, and how many
     faith-first stories may sit next to each other inside it. */
  var SPREAD_N = 12;
  var SPREAD_RUN = 2;

  /* ------------------------------------------------------------------ *
   * Derived facts about the map. Computed, never hand-maintained, so
   * they cannot drift away from MAP when somebody edits a weight.
   * ------------------------------------------------------------------ */

  function weightsFor(id) {
    return MAP[String(id)] || null;
  }

  function weight(id, genre) {
    var w = MAP[String(id)];
    return (w && w[genre]) ? w[genre] : 0;
  }

  function genresFor(id) {
    var w = MAP[String(id)], out = [], i;
    if (!w) return out;
    for (i = 0; i < GENRES.length; i++) {
      if (w[GENRES[i].key]) out.push(GENRES[i].key);
    }
    return out;
  }

  /* Stories that are faith-first: the Bible is their top read and nothing
     else reaches a 3. These are the ones with no mainstream door, and the
     only ones the spread rule holds back. Nine of them. */
  var PRIMARY_FAITH = (function () {
    var out = {}, i, j, id, w, best;
    for (i = 0; i < IDS.length; i++) {
      id = IDS[i]; w = MAP[id];
      if (w.bible !== 3) continue;
      best = 0;
      for (j = 0; j < GENRES.length; j++) {
        if (GENRES[j].key === "bible") continue;
        if ((w[GENRES[j].key] || 0) > best) best = w[GENRES[j].key] || 0;
      }
      if (best < 3) out[id] = true;
    }
    return out;
  })();

  function isFaithFirst(id) { return !!PRIMARY_FAITH[String(id)]; }

  /* Membership AND primaries. The two numbers answer different questions.
     `n` is "could this genre ever surface the story"; `strong` is "is this
     genre what the story IS". A genre with a big n and a small strong is a
     long tail, which is fine — the tail only wins when nothing better is in
     the running. A genre with a big n and NO shape is the "Famous lives"
     failure: it matches everything and therefore ranks nothing. */
  function counts() {
    var out = {}, i, j, ids, strong, w;
    for (i = 0; i < GENRES.length; i++) {
      ids = []; strong = [];
      for (j = 0; j < IDS.length; j++) {
        w = weight(IDS[j], GENRES[i].key);
        if (w > 0) ids.push(IDS[j]);
        if (w === 3) strong.push(IDS[j]);
      }
      out[GENRES[i].key] = {
        label: GENRES[i].label,
        n: ids.length,
        strong: strong.length,
        ids: ids,
        strongIds: strong
      };
    }
    return out;
  }

  /* Every story reachable from at least one genre? Returns the orphans. */
  function orphans() {
    var out = [], i;
    for (i = 0; i < IDS.length; i++) {
      if (genresFor(IDS[i]).length === 0) out.push(IDS[i]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Hook strength. A tie-break, derived from the text rather than from
   * a table of opinions, so it stays true when a hook is rewritten.
   *
   *   +2  a reversal ("wasn't", "never", "nobody", "actually") — the
   *       catalogue's strongest and most clickable shape
   *   +2  poses a question
   *   +1  short enough to read in one glance
   *   -3  the hook still has a raw markdown citation in it. Three of them
   *       do (08, 09, 10). That is an unedited hook and it should not lead
   *       anybody's feed until somebody fixes it.
   * ------------------------------------------------------------------ */
  var RE_REVERSAL = /(n['’]t|\bnever\b|\bnobody\b|\bno one\b|\bnot\b|\bactually\b)/i;

  function hookScore(story) {
    var h = (story && story.hook) ? String(story.hook) : "";
    var n = 0;
    if (!h) return 0;
    if (RE_REVERSAL.test(h)) n += 2;
    if (h.indexOf("?") > -1) n += 2;
    if (h.length <= 120) n += 1;
    if (h.indexOf("](http") > -1) n -= 3;
    return n;
  }

  /* ------------------------------------------------------------------ *
   * Picks.
   * ------------------------------------------------------------------ */
  function isGenre(k) {
    var i;
    for (i = 0; i < GENRES.length; i++) { if (GENRES[i].key === k) return true; }
    return false;
  }

  /* Drop unknowns, drop duplicates, keep tap order, cap at three. An empty
     or unusable pick list is not an error: it means "no preference", and
     the ranking falls through to hook strength and length, which is a
     perfectly good default feed. */
  function normalize(picks) {
    var out = [], i, k;
    if (!picks || typeof picks.length !== "number") return out;
    for (i = 0; i < picks.length && out.length < MAX_PICKS; i++) {
      k = String(picks[i]);
      /* legacy key from the mockup's vocabulary */
      if (k === "religion") k = "bible";
      if (k === "lives") k = "myths";
      if (!isGenre(k)) continue;
      if (indexOf(out, k) > -1) continue;
      out.push(k);
    }
    return out;
  }

  function indexOf(arr, v) {
    var i;
    for (i = 0; i < arr.length; i++) { if (arr[i] === v) return i; }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * The score. Three numbers per story, in strict priority order.
   *
   *   affinity  sum over picks of (pick multiplier x weight). The signal.
   *   strong    how many of their picks this story is a 3 for. Separates
   *             "dead centre of two things you asked for" from "a 3 and a 1"
   *             when the sums happen to land equal.
   *   matched   how many of their picks it touches at all. Breadth beats
   *             depth only after depth has spoken.
   * ------------------------------------------------------------------ */
  function score(id, picks) {
    var aff = 0, strong = 0, matched = 0, i, w;
    for (i = 0; i < picks.length; i++) {
      w = weight(id, picks[i]);
      if (w > 0) {
        aff += (PICK_MULT[i] || 1) * w;
        matched += 1;
        if (w === 3) strong += 1;
      }
    }
    return { aff: aff, strong: strong, matched: matched };
  }

  /* ------------------------------------------------------------------ *
   * Comparator. Every branch is a total order on integers or strings, and
   * the last branch is unique, so the sort is stable without relying on
   * the engine's sort being stable. Old webviews' sorts are not.
   *
   *   1  affinity        DESC   what they asked for
   *   2  strong matches  DESC   asked for it squarely
   *   3  matched genres  DESC   asked for it more than once
   *   4  free            DESC   an openable story beats a locked one; a
   *                             reader whose feed opens with a padlock is
   *                             a reader who does not open a second one
   *   5  hook strength   DESC   best sentence wins the slot
   *   6  length          ASC    the quicker win first; the promise made in
   *                             onboarding is "five minutes"
   *   7  id              ASC    deterministic backstop, never reached twice
   * ------------------------------------------------------------------ */
  function compare(a, b) {
    if (a.aff !== b.aff) return b.aff - a.aff;
    if (a.strong !== b.strong) return b.strong - a.strong;
    if (a.matched !== b.matched) return b.matched - a.matched;
    if (a.free !== b.free) return b.free - a.free;
    if (a.hook !== b.hook) return b.hook - a.hook;
    if (a.secs !== b.secs) return a.secs - b.secs;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  /* ------------------------------------------------------------------ *
   * Catalogue plumbing. `stacks` is the array out of data/index.json. It
   * is optional: without it we still rank, we just lose hook strength and
   * length, and the free flag falls back to the two stories that have
   * always been free.
   * ------------------------------------------------------------------ */
  var FALLBACK_FREE = { "01": true, "02": true };

  function indexStacks(stacks) {
    var by = {}, i, s;
    if (!stacks || typeof stacks.length !== "number") return by;
    for (i = 0; i < stacks.length; i++) {
      s = stacks[i];
      if (s && s.id !== undefined && s.id !== null) by[String(s.id)] = s;
    }
    return by;
  }

  /* ------------------------------------------------------------------ *
   * Pass: hold the faith-first stories apart in the opening feed.
   *
   * Only when the reader did NOT tick "The Bible, honestly". Inside the
   * first SPREAD_N slots, no more than SPREAD_RUN faith-first stories may
   * sit consecutively; when a third would land, the next non-faith-first
   * story from further down is pulled up into the slot and the displaced
   * one keeps its relative order behind it.
   *
   * This does not suppress or hide anything — the list is still all 51 and
   * the same 51 — and it deliberately cannot fix the underlying ratio. It
   * fixes the FIRST IMPRESSION, which is the only thing a reader judges
   * "did this thing listen to me" on. Beyond slot twelve it stops, because
   * by then the reader has chosen to keep going.
   * ------------------------------------------------------------------ */
  function spread(order, picks) {
    var out = [], run = 0, i, j, taken, moved;
    if (indexOf(picks, "bible") > -1) return order;
    taken = {};
    for (i = 0; i < order.length; i++) {
      if (out.length >= SPREAD_N) break;
      if (taken[order[i]]) continue;
      if (isFaithFirst(order[i]) && run >= SPREAD_RUN) {
        /* find the next story that is not faith-first */
        moved = -1;
        for (j = i + 1; j < order.length; j++) {
          if (taken[order[j]]) continue;
          if (!isFaithFirst(order[j])) { moved = j; break; }
        }
        if (moved > -1) {
          out.push(order[moved]);
          taken[order[moved]] = true;
          run = 0;
          i = i - 1; /* reconsider the held-back story in the next slot */
          continue;
        }
        /* nothing left to pull up: the ratio wins, honestly */
      }
      out.push(order[i]);
      taken[order[i]] = true;
      run = isFaithFirst(order[i]) ? run + 1 : 0;
    }
    /* everything not yet emitted, in its original order */
    for (i = 0; i < order.length; i++) {
      if (!taken[order[i]]) out.push(order[i]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Pass: the lead slot must be openable.
   *
   * The single most expensive mistake this funnel can make is handing a
   * brand new reader a padlock as their first story. So slot one is
   * reserved for the best-ranked FREE story, whatever the score said. It
   * is a promotion, not a rewrite: the rest of the order is untouched.
   * ------------------------------------------------------------------ */
  function lead(order, freeOf) {
    var i, id;
    for (i = 0; i < order.length; i++) {
      if (freeOf(order[i])) {
        if (i === 0) return order;
        id = order[i];
        order = order.slice(0, i).concat(order.slice(i + 1));
        return [id].concat(order);
      }
    }
    return order;
  }

  /* ------------------------------------------------------------------ *
   * rankDetailed(picks, stacks, opts) -> [{ id, aff, strong, matched, ... }]
   * rank(picks, stacks, opts)         -> ["02", "23", ...]  all 51, best first
   *
   * opts.exclude  array of ids already read. Not dropped — moved to the
   *               tail. The contract is "all 51, ordered", and a caller
   *               that wants a shortlist can slice it.
   * opts.spread   false to switch the religious-spread pass off.
   * opts.lead     false to switch the free-story-first pass off.
   * ------------------------------------------------------------------ */
  function rankDetailed(picks, stacks, opts) {
    var p = normalize(picks);
    var by = indexStacks(stacks);
    var o = opts || {};
    var rows = [], i, id, s, sc, ex = {}, head = [], tail = [], byId = {};

    if (o.exclude && typeof o.exclude.length === "number") {
      for (i = 0; i < o.exclude.length; i++) ex[String(o.exclude[i])] = true;
    }

    function freeOf(x) {
      var st = by[String(x)];
      if (st && typeof st.free === "boolean") return st.free;
      return !!FALLBACK_FREE[String(x)];
    }

    for (i = 0; i < IDS.length; i++) {
      id = IDS[i];
      s = by[id] || null;
      sc = score(id, p);
      rows.push({
        id: id,
        aff: sc.aff,
        strong: sc.strong,
        matched: sc.matched,
        free: freeOf(id) ? 1 : 0,
        hook: hookScore(s),
        secs: (s && typeof s.secs === "number") ? s.secs : 240,
        faithFirst: isFaithFirst(id) ? 1 : 0,
        title: (s && s.title) ? s.title : "",
        topic: (s && s.topic) ? s.topic : "",
        genres: genresFor(id),
        seen: ex[id] ? 1 : 0
      });
    }

    rows.sort(compare);

    for (i = 0; i < rows.length; i++) {
      byId[rows[i].id] = rows[i];
      if (rows[i].seen) tail.push(rows[i].id); else head.push(rows[i].id);
    }

    if (o.spread !== false) head = spread(head, p);
    if (o.lead !== false) head = lead(head, freeOf);

    rows = [];
    head = head.concat(tail);
    for (i = 0; i < head.length; i++) {
      byId[head[i]].rank = i + 1;
      rows.push(byId[head[i]]);
    }
    return rows;
  }

  function rank(picks, stacks, opts) {
    var rows = rankDetailed(picks, stacks, opts), out = [], i;
    for (i = 0; i < rows.length; i++) out.push(rows[i].id);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Copy. The strings that are allowed to change with the answers, in the
   * one file that knows whether the ranking behind them is real.
   *
   * disclosure() is not decoration. Render it under the genre grid. It is
   * the sentence that makes the personalization honest rather than a
   * cheque the catalogue cannot cash — see the header. If a template drops
   * it, the funnel is overclaiming.
   * ------------------------------------------------------------------ */
  function labelOf(key) {
    var i;
    for (i = 0; i < GENRES.length; i++) {
      if (GENRES[i].key === key) return GENRES[i].label;
    }
    return key;
  }

  function joinLabels(picks) {
    var p = normalize(picks), parts = [], i;
    for (i = 0; i < p.length; i++) parts.push(labelOf(p[i]).toLowerCase());
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return parts.slice(0, parts.length - 1).join(", ") + " and " +
           parts[parts.length - 1];
  }

  function disclosure() {
    return "Most of these stories come from the ancient world and the Bible — " +
           "told as history, not scripture. Your picks set the order you meet " +
           "them in.";
  }

  /* The loader / "building your feed" line. Truthful about what it did:
     it ordered a fixed shelf, it did not assemble a bespoke one. */
  function copyFor(picks) {
    var p = normalize(picks);
    var n = p.length;
    return {
      picked: p,
      labels: joinLabels(p),
      /* No story count in reader-facing copy. The number is small enough
         that printing it argues against the purchase, and it moves every
         time a story is added — a figure in copy is a figure to maintain. */
      loaderHead: n ? "Ordering your stories around " + joinLabels(p) + "."
                    : "Putting your stories in order.",
      loaderSub: "Nothing is locked away by this. It changes what you meet first.",
      disclosure: disclosure()
    };
  }

  return {
    VERSION: VERSION,

    /* vocabulary */
    GENRES: GENRES,
    MAP: MAP,
    IDS: IDS,
    labelOf: labelOf,

    /* facts about the map */
    weightsFor: weightsFor,
    weight: weight,
    genresFor: genresFor,
    counts: counts,
    orphans: orphans,
    isFaithFirst: isFaithFirst,
    faithFirstIds: (function () {
      var out = [], k;
      for (k in PRIMARY_FAITH) { if (PRIMARY_FAITH.hasOwnProperty(k)) out.push(k); }
      out.sort();
      return out;
    })(),

    /* ranking */
    normalize: normalize,
    hookScore: hookScore,
    rank: rank,
    rankDetailed: rankDetailed,

    /* copy */
    copyFor: copyFor,
    disclosure: disclosure,

    /* knobs, exported so a test can assert on them rather than guess */
    PICK_MULT: PICK_MULT,
    MAX_PICKS: MAX_PICKS,
    SPREAD_N: SPREAD_N,
    SPREAD_RUN: SPREAD_RUN
  };
})();

if (typeof window !== "undefined") { window.FBFIT = FBFIT; }
if (typeof module !== "undefined" && module.exports) { module.exports = FBFIT; }

/* ==========================================================================
   SELF-TEST. Node only. Guarded on the absence of `window`, so it can never
   run in a browser or in a webview, and on module.exports so it does not run
   when the file is merely concatenated into a bundle.

     node js/personalize.js

   It loads the real data/index.json when it can find it, and falls back to
   the map alone when it cannot, so it still tells you something on a machine
   without the data checked out.
   ========================================================================== */
if (typeof window === "undefined" && typeof module !== "undefined" &&
    module.exports && typeof require === "function" && require.main === module) {
  (function () {
    "use strict";
    var fs = require("fs"), path = require("path");
    var fails = 0;

    function ok(cond, what) {
      if (!cond) { fails++; console.log("  FAIL  " + what); }
      else { console.log("  ok    " + what); }
    }

    var stacks = null;
    var p = path.join(__dirname, "..", "data", "index.json");
    try { stacks = JSON.parse(fs.readFileSync(p, "utf8")).stacks; }
    catch (e) { console.log("(no data/index.json at " + p + " — running on the map alone)"); }

    console.log("\nFBFIT " + FBFIT.VERSION + " — self-test");
    console.log("catalogue: " + (stacks ? stacks.length + " stories from index.json"
                                        : FBFIT.IDS.length + " ids from the map"));

    /* ---- coverage ---- */
    console.log("\nGENRES");
    var c = FBFIT.counts(), i, g, total = 0, minN = 999;
    for (i = 0; i < FBFIT.GENRES.length; i++) {
      g = FBFIT.GENRES[i].key;
      total += c[g].n;
      if (c[g].n < minN) minN = c[g].n;
      console.log("  " + pad(c[g].label, 26) + pad(String(c[g].n), 5) +
                  "stories   " + pad(String(c[g].strong), 4) + "of them primary");
    }
    console.log("  " + pad("(memberships)", 26) + pad(String(total), 5) +
                "across " + FBFIT.IDS.length + " stories");

    console.log("");
    ok(FBFIT.IDS.length === 51, "the map holds 51 stories");
    ok(FBFIT.orphans().length === 0,
       "every story is in at least one genre (orphans: " +
       (FBFIT.orphans().join(",") || "none") + ")");
    ok(minN >= 5, "no genre has fewer than 5 stories (smallest: " + minN + ")");

    if (stacks) {
      var missing = [], extra = [], seen = {}, j;
      for (j = 0; j < stacks.length; j++) {
        seen[String(stacks[j].id)] = true;
        if (!FBFIT.weightsFor(stacks[j].id)) missing.push(stacks[j].id);
      }
      for (j = 0; j < FBFIT.IDS.length; j++) {
        if (!seen[FBFIT.IDS[j]]) extra.push(FBFIT.IDS[j]);
      }
      ok(missing.length === 0, "every story in index.json is mapped (" +
         (missing.join(",") || "none missing") + ")");
      ok(extra.length === 0, "the map invents no stories (" +
         (extra.join(",") || "none extra") + ")");
    }

    console.log("\n  faith-first (no mainstream door): " +
                FBFIT.faithFirstIds.length + " of 29 biblical — " +
                FBFIT.faithFirstIds.join(", "));

    /* ---- ranking ---- */
    function check(picks, note) {
      var r = FBFIT.rank(picks, stacks);
      var r2 = FBFIT.rank(picks, stacks);
      var uniq = {}, k, n = 0;
      for (k = 0; k < r.length; k++) { if (!uniq[r[k]]) { uniq[r[k]] = 1; n++; } }
      ok(r.length === 51, note + ": returns 51 ids");
      ok(n === 51, note + ": all ids distinct");
      ok(r.join(",") === r2.join(","), note + ": deterministic across calls");
      return r;
    }

    console.log("\nRANKING");
    check(["scandal", "mystery"], "scandal+mystery");
    check(["bible", "myths", "power"], "bible+myths+power");
    check([], "no picks");
    check(["religion", "lives"], "legacy mockup keys");
    check(["nonsense", "scandal", "scandal", "war", "power", "myths"], "dirty input");

    /* lead slot openable */
    var lr = FBFIT.rank(["bible", "myths"], stacks);
    var byId = {};
    if (stacks) { for (i = 0; i < stacks.length; i++) byId[String(stacks[i].id)] = stacks[i]; }
    ok(!stacks || byId[lr[0]].free === true, "lead slot is a free story (" + lr[0] + ")");

    /* spread rule holds for a reader who did not tick the Bible */
    var sr = FBFIT.rank(["scandal", "mystery"], stacks), run = 0, worst = 0;
    for (i = 0; i < FBFIT.SPREAD_N && i < sr.length; i++) {
      run = FBFIT.isFaithFirst(sr[i]) ? run + 1 : 0;
      if (run > worst) worst = run;
    }
    ok(worst <= FBFIT.SPREAD_RUN,
       "no run of more than " + FBFIT.SPREAD_RUN +
       " faith-first stories in the opening " + FBFIT.SPREAD_N +
       " (worst run: " + worst + ")");

    /* exclusions go to the tail, they do not vanish */
    var er = FBFIT.rank(["power"], stacks, { exclude: ["50", "21"] });
    ok(er.length === 51 && er[49] !== undefined &&
       (er[er.length - 1] === "50" || er[er.length - 1] === "21"),
       "excluded stories are pushed to the tail, not dropped");

    /* ---- two sample feeds, printed ---- */
    function show(picks, title) {
      var rows = FBFIT.rankDetailed(picks, stacks), k, r;
      console.log("\n" + title);
      console.log("  " + FBFIT.copyFor(picks).loaderHead);
      for (k = 0; k < 12; k++) {
        r = rows[k];
        console.log("  " + pad(String(k + 1) + ".", 4) +
                    pad(r.id, 5) +
                    pad("aff " + r.aff, 8) +
                    pad(r.free ? "FREE" : "lock", 6) +
                    pad(r.topic, 16) +
                    (r.faithFirst ? "* " : "  ") +
                    (r.title || "(no index.json)"));
      }
    }
    show(["scandal", "mystery"], "FEED A — Scandal & desire + Unsolved mysteries");
    show(["bible", "power", "war"], "FEED B — The Bible, honestly + Power & betrayal + Wars & empires");
    console.log("\n  * = faith-first (Bible is its only strong genre)");

    function pad(s, n) {
      s = String(s === undefined || s === null ? "" : s);
      while (s.length < n) s += " ";
      return s;
    }

    console.log("\n" + (fails ? fails + " FAILURE(S)" : "all checks passed") + "\n");
    process.exit(fails ? 1 : 0);
  })();
}
