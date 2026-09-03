/* ==========================================================================
   Factbox reader (/read) — ambient sound for all 51 stacks.

   One looping bed per card, crossfaded when the bed changes and HELD — nothing
   touched at all — when consecutive cards resolve to the same bed. Off by
   default, one tap on, one tap off, remembered across reloads and across
   stories. If Web Audio is missing, the context will not start, or the beds
   are not on the server, it is a silent no-op and the control removes itself.

   Owns: this file, css/audio-reader.css, data/audio.json, and the two elements
   it appends to <body>. It touches nothing else. It reads exactly four things
   out of the reader's DOM, all of them read-only:

       #deck                      the scroller
       .beat.live                 which card is on screen  (set by progress.js)
       data-stack / data-topic    which story this is       (set by read.html)
       data-beat                  where in the arc we are   (set by read.html)

   If `.live` never arrives it falls back to deck.scrollTop / clientHeight, so
   the feature still works if that contract is not wired. It knows nothing
   about stacks.json, so new stories need no change here — only a row in
   data/audio.json, and not even that (they fall through to their topic).

   ---------------------------------------------------------------------------
   Why Web Audio and not <audio> — the hard-won part, inherited from the
   flagship story's engine and unchanged because the platform has not changed:

   1. iOS Safari ignores HTMLMediaElement.volume. Setting it from script is a
      no-op on iPhone. A crossfade is animating gain, so an <audio> crossfade
      does not merely stutter on the platform that is ~all of our traffic — it
      does not exist. A GainNode is honoured everywhere.
   2. <audio loop> re-buffers at the loop point and audibly gaps. An
      AudioBufferSourceNode with loop = true is sample-exact.
   3. Gain ramps are scheduled on the audio thread, so a fade does not wobble
      when the main thread is busy — and it always is, because the reader is
      mid-scroll-snap at exactly the moment a fade starts.

   The cost is that a bed is decoded to PCM in memory, so the beds are short,
   mono and low-bitrate, at most CACHE_MAX are kept decoded, and the context
   runs at 32 kHz. A bed costs ~3 MB decoded and ~130 KB over the wire.

   NEVER THROWS. The whole body is inside a try/catch and every DOM lookup is
   guarded. This site has shipped blank twice because a script threw at top
   level; this file will not be the third.
   ========================================================================== */

(function () {
  "use strict";
  try { main(); } catch (e) { /* a silent page is bad; a blank page is worse */ }

  function main() {

  /* ---- tuning ----------------------------------------------------------
     The founder's note on the flagship was "the audio was a little loud, make
     it a bit quieter so it's not the main focus". That build ran the master at
     0.26 (0.17 under reduced motion). This reader runs 3.7 dB below it: its
     normal level IS the flagship's reduced-motion level. The target is that a
     reader is not aware of the sound until they think about it.

     Lowering a master cannot disturb the balance between beds — every one of
     the eighteen moves by the same 3.7 dB — but it can push the quietest bed
     off the bottom, and the rule from the flagship applies: move the bed that
     falls off, not the master. Three beds were raised in data/audio.json for
     exactly that reason (search 0.50 -> 0.72, coil 0.85 -> 0.95,
     door 0.90 -> 0.95); everything else kept its flagship gain. */
  var LEVEL      = 0.17;   /* master, sound on                                */
  var LEVEL_CALM = 0.11;   /* master under prefers-reduced-motion             */
  var TAU        = 0.55;   /* crossfade time constant, seconds — see ramp()   */
  var STOP_AFTER = 2800;   /* ms after a fade-out before the voice is freed   */
  var CACHE_MAX  = 3;      /* decoded beds held at once                       */
  var HEAD_TRIM  = 0.05;   /* seconds skipped at the loop head — see play()   */
  var TAIL_TRIM  = 0.10;   /* seconds skipped at the loop tail                */

  var CFG_URL = "/data/audio.json";
  var K_ON    = "fb-sound";       /* "on" | "off" — shared with story.html    */
  var K_HINT  = "fb-sound-hint";  /* the silent-switch note, shown once ever  */

  /* ------------------------------------------------------------------------
     The fallback map.

     data/audio.json is the real map — per stack, per beat — and it is fetched
     lazily, on the tap, along with the first bed. This is what runs if that
     fetch fails: one bed per topic, no beat moves. It exists so that a missing
     or malformed JSON degrades to "every story sounds like its topic" rather
     than to silence, and so this file is still correct on its own.
     ------------------------------------------------------------------------ */
  var CFG = {
    base: "/audio/",
    "default": "scroll",
    beds: {
      "palace":  { file: "palace.mp3",  gain: 0.85 },
      "harbour": { file: "harbour.mp3", gain: 1.00 },
      "harbour-arrival": { file: "harbour-arrival.mp3", gain: 0.86 },
      "sea":     { file: "sea.mp3",     gain: 1.00 },
      "triumph": { file: "triumph.mp3", gain: 0.95 },
      "bath":    { file: "bath.mp3",    gain: 0.80 },
      "letter":  { file: "letter.mp3",  gain: 0.80 },
      "copies":  { file: "copies.mp3",  gain: 0.85 },
      "scroll":  { file: "scroll.mp3",  gain: 0.85 },
      "basket":  { file: "basket.mp3",  gain: 0.85 },
      "vials":   { file: "vials.mp3",   gain: 0.75 },
      "gallery": { file: "gallery.mp3", gain: 0.80 },
      "vault":   { file: "vault.mp3",   gain: 0.85 },
      "wind":    { file: "wind.mp3",    gain: 0.85 },
      "reactor": { file: "reactor.mp3", gain: 0.85 },
      "door":    { file: "door.mp3",    gain: 0.95 },
      "coil":    { file: "coil.mp3",    gain: 0.95 },
      "search":  { file: "search.mp3",  gain: 0.72 }
    },
    topics: {
      "cleopatra":       { bed: "palace",  beats: { "question": "coil" } },
      "ancient_world":   { bed: "palace",  beats: { "question": "coil" } },
      "old_testament":   { bed: "wind" },
      "new_testament":   { bed: "copies" },
      "church_history":  { bed: "vault" },
      "us_history":      { bed: "letter" },
      "medieval_modern": { bed: "vault" },
      "disaster":        { bed: "reactor" }
    },
    stacks: {}
  };
  var cfgPromise = null;

  /* ------------------------------------------------------------------------
     Bail out silently on anything that cannot possibly work. No control, no
     listeners, no console noise — a page that never offered sound. jsdom and
     any browser without Web Audio land here, which is the intended path.
     ------------------------------------------------------------------------ */
  var AC = window.AudioContext || window.webkitAudioContext;
  var deck = document.getElementById("deck");
  if (!AC || !window.fetch || !window.Promise || !window.MutationObserver ||
      !deck || !document.body) return;

  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function calm() {
    return !!((mq && mq.matches) ||
              document.documentElement.classList.contains("no-motion"));
  }
  function level() { return calm() ? LEVEL_CALM : LEVEL; }

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function recall(k)   { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function forget(k)   { try { localStorage.removeItem(k); } catch (e) {} }

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */
  var ctx = null, master = null;
  var buffers = {}, failed = {}, loading = {}, lru = [];
  var voices  = {};                 /* key -> { gain, src, kill }             */
  var on = false;                   /* sound is on and the context is live    */
  var armed = false;                /* remembered "on", waiting for a gesture */
  var dead = false;                 /* nothing to play; control retired       */
  var shown = false;                /* the control is in the DOM              */
  var everLoaded = false, probed = false, hinted = !!recall(K_HINT);
  var liveKey = null;
  var hideTimer = 0, noteTimer = 0, rafPending = 0;
  var unwake = function () {};      /* set below if a choice was remembered   */

  /* ------------------------------------------------------------------------
     Which bed a card wants.

     Most specific wins:
        stacks[stack].cards[card]  ->  stacks[stack].beats[beat]
     -> stacks[stack].bed          ->  topics[topic].beats[beat]
     -> topics[topic].bed          ->  default

     The first rung is the per-card map (data/cardaudio.json, merged into
     data/audio.json; see AUDIO-CARDS.md). `card` is the 0-based index
     read.html writes into data-card — the s.cards.map(function (c, n)) index,
     NOT the 1-based c.n in stacks.json, which differ wherever a stack has a
     gap in its numbering. Stack 26 is the one that does: nine cards whose n
     runs 1–8 then 10, so its keys are "0"…"8" and every one of them would be
     off by one against c.n from card 9 on.

     Every rung is still guarded on CFG.beds[…], so a card naming a bed whose
     mp3 is not in the manifest falls through to the next rung rather than to
     silence. That is the whole ladder, unchanged below the new top rung.

     A card carrying neither data-stack nor data-topic — the paywall pane, the
     end card — resolves to null, and null HOLDS whatever is already playing
     rather than cutting to silence. So the story's last bed carries through
     the ending as a coda, which is what it should do anyway.
     ------------------------------------------------------------------------ */
  function attr(el, n) {
    try { return (el && el.getAttribute) ? el.getAttribute(n) : null; } catch (e) { return null; }
  }
  function pick(node, beat, card) {
    if (!node) return null;
    if (card != null && node.cards && node.cards[card] &&
        CFG.beds[node.cards[card].bed]) return node.cards[card].bed;
    if (beat && node.beats && node.beats[beat] && CFG.beds[node.beats[beat]])
      return node.beats[beat];
    if (node.bed && CFG.beds[node.bed]) return node.bed;
    return null;
  }
  function keyOf(el) {
    if (!el) return null;
    var stack = attr(el, "data-stack"), topic = attr(el, "data-topic");
    if (!stack && !topic) return null;          /* not a scored card: hold    */
    var beat = attr(el, "data-beat"), card = attr(el, "data-card");
    var k = pick(CFG.stacks && stack ? CFG.stacks[stack] : null, beat, card);
    if (k) return k;
    k = pick(CFG.topics && topic ? CFG.topics[topic] : null, beat, card);
    if (k) return k;
    return CFG.beds[CFG["default"]] ? CFG["default"] : null;
  }
  function scorable(el) {
    return !!(el && (attr(el, "data-stack") || attr(el, "data-topic")));
  }

  /* `.beat.live` is the contract, and read.html sets it from an
     IntersectionObserver at threshold 0.55 — so exactly one card carries it
     at a time, which is the answer we want.

     Except in two cases, and both are why the scroll-position fallback below
     exists rather than being paranoia:

       * read.html's no-IntersectionObserver path marks EVERY card live at
         once ("worse for battery, correct for reading"). Taking the first
         match there would pin the sound to card 1 for the whole story.
       * between two cards there is briefly no `.live` at all.

     So: trust the class only when exactly one card carries it. Otherwise fall
     back to deck.scrollTop / clientHeight, which on a full-height snapping
     deck gives the same answer. Either way sync() acts only when the resolved
     BED changes, so being one card out costs nothing at all. */
  function livePage() {
    var els = null;
    try { els = deck.querySelectorAll(".beat.live"); } catch (e) {}
    if (els && els.length === 1 && scorable(els[0])) return els[0];
    var kids = deck.children;
    if (!kids || !kids.length) return (els && els[0]) || null;
    var h = deck.clientHeight || 0;
    if (!h) return kids[0];
    var n = Math.round((deck.scrollTop || 0) / h);
    if (n < 0) n = 0;
    if (n > kids.length - 1) n = kids.length - 1;
    return kids[n] || null;
  }

  /* Read-ahead. The useful answer is not "the next card's bed" — on a story
     that holds one bed for ten cards that is the bed already playing — it is
     "the next bed that is DIFFERENT", i.e. the next crossfade. Bounded to
     three cards so a story whose only change is at card nine does not pull a
     file the reader may never reach. */
  function nextKeyAfter(el, cur) {
    var n = el && el.nextElementSibling, hops = 0;
    while (n && hops < 3) {
      var k = keyOf(n);
      if (k && k !== cur) return k;
      if (k) hops++;
      n = n.nextElementSibling;
    }
    return null;
  }
  function anyOtherKey(not) {
    var kids = deck.children;
    for (var i = 0; i < kids.length; i++) {
      var k = keyOf(kids[i]);
      if (k && k !== not) return k;
    }
    return null;
  }
  function hasScorable() {
    var kids = deck.children;
    for (var i = 0; i < kids.length; i++) if (scorable(kids[i])) return true;
    return false;
  }

  /* ------------------------------------------------------------------------
     Engine
     ------------------------------------------------------------------------ */
  function makeCtx() {
    if (ctx) return ctx;
    try {
      /* 32 kHz: these are ambiences, nothing above 16 kHz survives a 48 kbps
         mono encode anyway, and it cuts the decoded footprint by a third.
         Older Safari throws on an unsupported rate, hence the plain retry. */
      ctx = new AC({ sampleRate: 32000, latencyHint: "playback" });
    } catch (e) {
      try { ctx = new AC(); } catch (e2) { return null; }
    }
    try {
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
    } catch (e3) { ctx = null; return null; }
    return ctx;
  }

  /* A crossfade wants equal power, and the textbook answer is
     setValueCurveAtTime with a cosine pair. It is the wrong answer here: a
     reader flicking through cards fires overlapping fades, and a curve that
     overlaps a scheduled event THROWS, mid-story, on the audio thread.
     setTargetAtTime cannot collide — it always starts from wherever the value
     actually is right now and approaches exponentially. Two uncorrelated
     ambient beds crossfaded exponentially dip by well under a decibel in the
     middle, which nobody has ever heard. Robustness wins. */
  function ramp(param, target) {
    if (!param || !ctx) return;
    var t = ctx.currentTime;
    try {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
      else param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
    } catch (e) {}
    try { param.setTargetAtTime(target, t, TAU); }
    catch (e) { try { param.value = target; } catch (e2) {} }
  }

  /* Least-recently-wanted, with the wrinkle that a bed which is currently
     sounding is never evicted however old it is. Bounded by one pass so a deck
     where everything is in use cannot spin. */
  function touch(key) {
    var i = lru.indexOf(key);
    if (i >= 0) lru.splice(i, 1);
    lru.push(key);
    for (var n = lru.length; n > 0 && lru.length > CACHE_MAX; n--) {
      var old = lru.shift();
      if (!voices[old] && old !== liveKey) delete buffers[old];
      else lru.push(old);
    }
  }

  function url(key) {
    var b = CFG.beds[key];
    return (CFG.base || "/audio/") + (b ? b.file : "");
  }

  function load(key) {
    if (!key || !CFG.beds[key] || !ctx) return Promise.resolve(null);
    if (buffers[key]) { touch(key); return Promise.resolve(buffers[key]); }
    if (failed[key])  return Promise.resolve(null);      /* never retried     */
    if (loading[key]) return loading[key];

    var p = fetch(url(key), { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        return new Promise(function (res, rej) {
          /* Safari before 14 only has the callback form and returns undefined;
             everything else also returns a promise. Both are wired up. */
          var out = ctx.decodeAudioData(buf, res, rej);
          if (out && out.then) out.then(res, rej);
        });
      })
      .then(function (b) {
        if (!b) throw new Error("empty");
        buffers[key] = b; everLoaded = true; touch(key); return b;
      })
      .catch(function () { failed[key] = 1; return null; })
      .then(function (b) { delete loading[key]; return b; });

    loading[key] = p;
    return p;
  }

  function play(key) {
    var bed = CFG.beds[key], buf = buffers[key];
    if (!bed || !buf || !ctx) return;
    var gain = typeof bed.gain === "number" ? bed.gain : 0.85;

    var v = voices[key];
    if (v) {                       /* still fading out — catch it and lift it */
      if (v.kill) { clearTimeout(v.kill); v.kill = 0; }
      ramp(v.gain.gain, gain);
      return;
    }

    var g, s;
    try {
      g = ctx.createGain();
      g.gain.value = 0;
      g.connect(master);

      s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      /* MP3 decoding adds encoder delay at the head and padding at the tail,
         and no browser strips it consistently — looping the whole buffer
         therefore ticks once per lap. Looping inside the file steps over both.
         The beds are built noise-like precisely so this small jump has nothing
         tonal to break; see AUDIO-READER.md. */
      var d = buf.duration || 0;
      s.loopStart = Math.min(HEAD_TRIM, d * 0.02);
      s.loopEnd   = Math.max(s.loopStart + 0.5, d - TAIL_TRIM);
      s.connect(g);
    } catch (e) { return; }
    try { s.start(0, s.loopStart); }
    catch (e) { try { s.start(0); } catch (e2) { return; } }

    voices[key] = { gain: g, src: s, kill: 0 };
    ramp(g.gain, gain);
  }

  function fade(key) {
    var v = voices[key];
    if (!v || v.kill) return;
    ramp(v.gain.gain, 0);
    v.kill = setTimeout(function () {
      try { v.src.stop(); } catch (e) {}
      try { v.src.disconnect(); v.gain.disconnect(); } catch (e) {}
      delete voices[key];
    }, STOP_AFTER);
  }
  function fadeAllBut(key) {
    for (var k in voices) if (k !== key) fade(k);
  }

  function go(key) {
    if (!key) return;                 /* unmapped card: hold, do not go quiet */
    fadeAllBut(key);
    if (buffers[key]) { play(key); afterFirstSound(); }
    else load(key).then(function (b) {
      if (!b || !on || liveKey !== key) return;
      play(key);
      afterFirstSound();
    });
    var nxt = nextKeyAfter(livePage(), key);
    if (nxt) load(nxt);                    /* the next crossfade, prefetched  */
  }

  /* ------------------------------------------------------------------------
     THE ONE THING THIS FILE IS FOR.

     sync() resolves the live card to a bed KEY and returns immediately if that
     key has not changed. Ten cards of the same story resolve to the same bed,
     so nine of those ten swipes do nothing at all: no fetch, no node, no ramp,
     no restart. The bed keeps running underneath the reader and the deck moves
     over the top of it. Only a genuine change of bed — the `question` card of
     a violent death dropping to `coil`, the `landing` coming back up — costs a
     crossfade. That is the behaviour; everything else here is plumbing.

     Between cards there is briefly no `.live` element at all; holding through
     that gap is what stops the sound flickering on every swipe.
     ------------------------------------------------------------------------ */
  function sync() {
    if (dead) return;
    if (!shown && hasScorable()) reveal();
    var k = keyOf(livePage());
    if (!k || k === liveKey) return;      /* HOLD. This is the common case.   */
    liveKey = k;
    if (on) go(k);
  }
  function schedule() {
    if (rafPending) return;
    rafPending = 1;
    var fn = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    fn(function () { rafPending = 0; try { sync(); } catch (e) {} });
  }

  /* The deck is filled asynchronously from stacks.json, so childList matters
     as much as class. The observer fires on anything under the deck, so sync()
     stays cheap and returns early. */
  try {
    new MutationObserver(schedule).observe(deck, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class"]
    });
  } catch (e) {}
  deck.addEventListener("scroll", schedule, { passive: true });
  schedule();

  /* ------------------------------------------------------------------------
     Config. Fetched lazily, on the tap, never before it — the promise made on
     the flagship was "no audio byte until a reader asks for sound", and this
     JSON is an audio byte. A failure keeps the built-in topic map above.
     ------------------------------------------------------------------------ */
  function loadCfg() {
    if (cfgPromise) return cfgPromise;
    cfgPromise = fetch(CFG_URL, { credentials: "omit" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.beds) return;
        /* Merge, do not replace: anything the file omits keeps the built-in
           value, so a truncated or partial JSON cannot take the sound out. */
        if (j.base) CFG.base = j.base;
        if (j["default"]) CFG["default"] = j["default"];
        var k;
        for (k in j.beds)   if (j.beds[k] && j.beds[k].file) CFG.beds[k]   = j.beds[k];
        for (k in j.topics || {}) CFG.topics[k] = j.topics[k];
        for (k in j.stacks || {}) CFG.stacks[k] = j.stacks[k];
      })
      .catch(function () {})
      .then(function () { liveKey = null; try { sync(); } catch (e) {} });
    return cfgPromise;
  }

  /* ------------------------------------------------------------------------
     On / off
     ------------------------------------------------------------------------ */
  function turnOn() {
    if (dead) return;
    unwake();
    if (!makeCtx()) { retire("Sound unavailable"); return; }
    on = true; armed = false;
    store(K_ON, "on");
    paint();

    var r; try { r = ctx.resume && ctx.resume(); } catch (e) {}
    if (r && r["catch"]) r["catch"](function () {});

    ramp(master.gain, level());
    loadCfg().then(function () {
      if (!on) return;
      if (!liveKey) liveKey = keyOf(livePage());
      go(liveKey);
      probe();
    });
  }

  function turnOff() {
    unwake();
    on = false; armed = false;
    store(K_ON, "off");
    paint();
    if (!ctx) return;
    ramp(master.gain, 0);
    setTimeout(function () {
      if (on) return;
      for (var k in voices) {
        var v = voices[k];
        if (v.kill) clearTimeout(v.kill);
        try { v.src.stop(); } catch (e) {}
        try { v.src.disconnect(); v.gain.disconnect(); } catch (e) {}
        delete voices[k];
      }
      try { ctx.suspend(); } catch (e) {}          /* stop burning CPU        */
    }, 900);
  }

  /* ------------------------------------------------------------------------
     "The page must work with no audio files present at all."

     It does — but a button that silently does nothing is worse than no button,
     so the first time sound is asked for we try the current bed and one other.
     If both fail and nothing has ever decoded, the folder is empty (or the
     host is serving HTML 404s) and the control says so and leaves. Two probes
     rather than one so that a single missing bed cannot retire the system.
     ------------------------------------------------------------------------ */
  function probe() {
    if (probed || everLoaded) return;
    probed = true;

    /* Two beds used to be fetched here, so that one missing file could not
       retire the whole system on its own. The second one was never heard: it
       is a different bed from the one playing, chosen precisely because it is
       different. At a mean of 132KB that was a sixth of a megabyte spent to
       answer a question, on every story, competing for bandwidth with the
       painting the reader is actually looking at.

       So it asks in order instead. The live bed is needed anyway, so the
       first probe is free; a second is fetched ONLY if the first failed,
       which is the only case where the extra file ever told us anything. */
    var a = liveKey || anyOtherKey(null);
    load(a).then(function () {
      if (everLoaded) { paint(); return; }   /* drop the busy pulse           */
      var b = anyOtherKey(a) || CFG["default"];
      if (!b || b === a) { retire("No sound available"); return; }
      load(b).then(function () {
        if (!everLoaded) retire("No sound available");
        else paint();
      });
    });
  }

  function retire(msg) {
    dead = true; on = false; armed = false;
    forget(K_ON);                       /* do not re-arm on the next reload   */
    if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
    if (!shown) { drop(); return; }     /* never seen: just go                */
    btn.className = "fb-sound is-dead";
    say(msg, 2600);                     /* the label used to carry this       */
    btn.setAttribute("aria-disabled", "true");
    btn.removeAttribute("aria-pressed");
    setTimeout(function () {
      btn.classList.add("is-gone");
      setTimeout(drop, 400);
    }, 2600);
  }
  function drop() {
    try { if (btn.parentNode) btn.parentNode.removeChild(btn); } catch (e) {}
    try { if (note.parentNode) note.parentNode.removeChild(note); } catch (e) {}
    shown = false;
  }

  /* ------------------------------------------------------------------------
     The silent switch.

     iOS mutes Web Audio when the hardware switch on the side of the phone is
     set to silent. There is no API that reports it: an AnalyserNode sees the
     graph, not the speaker, so the page cannot know and cannot honestly
     pretend to. All we can do is turn the one-second conclusion "this is
     broken" into "oh — the switch", the moment sound actually starts. Once per
     device, then never again.
     ------------------------------------------------------------------------ */
  var IOS = /iP(hone|od|ad)/.test(navigator.platform || "") ||
            /iPhone|iPad|iPod/.test(navigator.userAgent || "") ||
            (/Mac/.test(navigator.platform || "") && navigator.maxTouchPoints > 1);

  function afterFirstSound() {
    if (btn.classList.contains("is-busy")) paint();
    if (hinted) return;
    hinted = true;
    store(K_HINT, "1");
    say(IOS ? "Sound on. Hearing nothing? The silent switch on the side of your phone mutes this."
            : "Sound on. Hearing nothing? Check your device volume.", 5600);
  }
  function say(msg, ms) {
    note.textContent = msg;
    note.classList.add("on");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { note.classList.remove("on"); }, ms);
  }

  /* ------------------------------------------------------------------------
     The control.

     Built now, appended only once the deck actually contains a scored card —
     so the paywall pane, the error pane and the moment before the fetch lands
     never show a sound button with nothing to sound.

     It sits top-RIGHT: the reader's "back to Stories" pill is top-left, and
     the bottom ~15% of the viewport is under the Instagram / TikTok in-app
     browser toolbar, where nothing tappable may live.
     ------------------------------------------------------------------------ */
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fb-sound is-off";
  btn.innerHTML =
    '<span class="ico" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
           'stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z" fill="currentColor" stroke-width="1.6"/>' +
        '<g class="wav"><path d="M15.4 9.2a4 4 0 0 1 0 5.6"/><path d="M18.1 6.8a7.6 7.6 0 0 1 0 10.4"/></g>' +
        '<g class="cut"><path d="M16.2 9.8l4.4 4.4"/><path d="M20.6 9.8l-4.4 4.4"/></g>' +
      '</svg>' +
    '</span>';

  var note = document.createElement("div");
  note.className = "fb-sound-note";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");

  function paint() {
    var busy = (armed || (on && !everLoaded)) && !dead;
    btn.className = "fb-sound " + (on || armed ? "is-on" : "is-off") + (busy ? " is-busy" : "");
    /* No words. The speaker either has waves coming off it or a cross through
       it, which is the same thing every player on the phone already says, and
       a pill that reads "Sound off" over a painting is a caption competing
       with the painting. The state still has a name for anyone who cannot see
       the icon — it lives in aria-pressed and aria-label, below. */
    btn.setAttribute("aria-pressed", String(on || armed));
    btn.setAttribute("aria-label", (on || armed) ? "Ambient sound is on. Turn it off."
                                                 : "Ambient sound is off. Turn it on.");
  }

  btn.addEventListener("click", function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (dead) return;
    if (on || armed) turnOff(); else turnOn();
  });

  function reveal() {
    if (shown || dead) return;
    shown = true;
    paint();
    /* Into the reader's top-right rail if it has one, so the account pill and
       this button lay themselves out as a row instead of being handed the same
       fixed corner and covering each other. Body is the fallback, and is what
       the composed story pages use — they have no rail. */
    try {
      var rail = document.querySelector(".topbar-r");
      (rail || document.body).appendChild(btn);
      document.body.appendChild(note);
    }
    catch (e) { shown = false; return; }

    /* --------------------------------------------------------------------
       On by default, once.

       Every story is scored, so sound is on unless the reader turned it off:
       `!== "off"`, not `=== "on"`. Turning it off writes "off" and that is
       final — it survives reloads and every other story, because the key is
       per-origin and shared with the flagship reader. We ask once, they
       answer once, we do not ask again.

       Autoplay is blocked, so a remembered choice cannot start on its own, and
       nothing is fetched until it can. The control shows the state it will be
       in and waits, busy, for the first real gesture, which on a scroll deck
       is the reader's first swipe — about a second away. A page that tries and
       fails looks exactly like a page that never tried, because it does not
       try.
       -------------------------------------------------------------------- */
    if (recall(K_ON) !== "off" && !on) {
      armed = true;
      paint();
      var EVENTS = ["pointerdown", "touchend", "mousedown", "keydown"], i;
      var wake = function (e) {
        /* Not the button's own tap — that is a deliberate "off", and the click
           listener above owns it. */
        var t = e && e.target;
        if (!armed || (t && t.closest && t.closest(".fb-sound"))) return;
        turnOn();
      };
      unwake = function () {
        armed = false;
        for (var j = 0; j < EVENTS.length; j++)
          document.removeEventListener(EVENTS[j], wake, true);
      };
      for (i = 0; i < EVENTS.length; i++)
        document.addEventListener(EVENTS[i], wake, true);
    }
  }

  /* ------------------------------------------------------------------------
     Leaving, coming back, and iOS interruptions (a call, another app taking
     the audio session). Nothing should ever be heard from a page the reader is
     no longer looking at.
     ------------------------------------------------------------------------ */
  document.addEventListener("visibilitychange", function () {
    if (!ctx) return;
    if (document.hidden) {
      ramp(master.gain, 0);
      hideTimer = setTimeout(function () { try { ctx.suspend(); } catch (e) {} }, 600);
    } else {
      clearTimeout(hideTimer);
      if (!on) return;
      var r; try { r = ctx.resume && ctx.resume(); } catch (e) {}
      if (r && r["catch"]) r["catch"](function () {});
      ramp(master.gain, level());
    }
  });
  window.addEventListener("pagehide", function () {
    if (ctx) { try { ctx.suspend(); } catch (e) {} }
  });

  /* If the reader turns reduced motion on mid-read, follow it. */
  if (mq) {
    var reflect = function () { if (on && ctx) ramp(master.gain, level()); };
    if (mq.addEventListener) mq.addEventListener("change", reflect);
    else if (mq.addListener) mq.addListener(reflect);
  }

  }
})();
