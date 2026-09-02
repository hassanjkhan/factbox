/* ==========================================================================
   Factbox reader — ambient sound

   One looping bed per scene, crossfaded as `.live` moves down the deck. Off by
   default, one tap to turn on, one tap to turn off, remembered across beats and
   reloads. If the audio files are not on the server it is a silent no-op and
   the control removes itself.

   Owns: this file, audio.css, and the two elements it creates on <body>.
   Touches nothing the shell or the scenes own. It reads exactly one thing from
   them — the `.live` class on `.page`, which is the contract — and one thing
   from the DOM: the `s-*` class on that page's `.scene`, which is how a beat
   names its bed. Nothing here knows the story data, so new beats and new
   stories need no change in here beyond a row in BEDS.

   ---------------------------------------------------------------------------
   Why Web Audio and not <audio>

   The whole job is crossfading, and crossfading means animating gain:

   1. iOS Safari ignores `HTMLMediaElement.volume`. Setting it from script is a
      no-op on iPhone — the hardware volume is the only volume. A `<audio>`
      crossfade is therefore not merely janky on the platform that is ~all of
      our traffic, it does not exist. A GainNode is honoured everywhere.
   2. `<audio loop>` re-buffers at the loop point and audibly gaps. An
      AudioBufferSourceNode with `loop = true` is sample-exact, which is the
      difference between an ambience and a stutter every twenty seconds.
   3. Gain ramps are scheduled on the audio thread, so a crossfade does not
      wobble when the main thread is busy — and the main thread is busy exactly
      when a fade happens, because the reader is mid-scroll-snap.

   The cost is that a bed is decoded to PCM in memory, so the beds are short,
   mono and low-bitrate, at most three are kept decoded (see CACHE_MAX), and
   the context runs at 32 kHz. A bed costs about 3 MB decoded and ~120 KB over
   the wire.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------------
     The beds.

     Keyed by the scene class, not by beat index — which is what makes the
     "hold, don't restart" requirement fall out for free. Beats 2 and 3 are both
     s-fleet, so moving between them resolves to the same bed and the code below
     does nothing at all: the sea keeps rolling across the cut. Same for any
     other pair of adjacent beats that share a scene.

     There are more scene classes here than the current thirteen beats use.
     That is deliberate and it is the cheap direction to be wrong in: a mapped
     scene that no beat carries costs nothing at all (its bed is never
     requested, because beds are fetched by what is on screen), whereas an
     unmapped scene silently holds the previous bed. s-afternoon and s-scroll
     are kept for exactly that reason — s-bath, s-letter and s-search took over
     what s-afternoon and s-scroll used to cover twice each, and if a beat is
     ever moved back, it still sounds.

     `gain` is the bed's level relative to the master. It exists because these
     are field recordings with different natural loudnesses, and mastering them
     to a common level by ear is not something the code can do for you.

     Two of them are not levelling and should not be "corrected" to match the
     others. s-search is 0.50 because the aftermath of a search is supposed to
     be the quietest thing in the story — it is normalised to −26 LUFS like
     every other bed, because a bed encoded quiet is a bed encoded noisy at
     48 kbps, and it is made quiet here instead. s-triumph is 1.00 and
     s-harbour was pulled back to 0.86 underneath it so that the triumph is
     the loudest moment in the read — but most of what makes it feel like the
     loudest moment is that it has ~7 dB more energy above 500 Hz than
     anything either side of it, which is the part a phone speaker actually
     reproduces. It should land as "the room got busier", not "the volume
     went up".
     ------------------------------------------------------------------------ */
  var BASE = "audio/";
  var BEDS = {
    /* title, a shut door in near-dark      */ "s-door":      { file: "door.mp3",            gain: 0.90 },
    /* Actium, and the year after it        */ "s-fleet":     { file: "sea.mp3",             gain: 1.00 },
    /* the fleet enters the Great Harbour   */ "s-harbour":   { file: "harbour-arrival.mp3", gain: 0.86 },
    /* she will not be paraded through Rome */ "s-triumph":   { file: "triumph.mp3",         gain: 1.00 },
    /* the bathing room, her last day       */ "s-bath":      { file: "bath.mp3",            gain: 0.80 },
    /* the letter to Octavian               */ "s-letter":    { file: "letter.mp3",          gain: 0.75 },
    /* the question, and the verdict        */ "s-coil":      { file: "coil.mp3",            gain: 0.85 },
    /* the room after the guards searched   */ "s-search":    { file: "search.mp3",          gain: 0.50 },
    /* the scriptorium that copied Plutarch */ "s-copies":    { file: "copies.mp3",          gain: 0.80 },
    /* the asp under the basket of figs     */ "s-basket":    { file: "basket.mp3",          gain: 0.85 },
    /* the physician's table                */ "s-mausoleum":     { file: "vials.mp3",           gain: 0.70 },
    /* weavers put the snake in anyway      */ "s-painting":  { file: "gallery.mp3",         gain: 0.75 },
    /* Alexandria at dusk                   */ "s-pharos":    { file: "harbour.mp3",         gain: 1.00 },

    /* Kept from the eight-scene cut. As the new scenes land these stop being
       carried by any beat; until then they still are, and either way it
       sounds. See above. */
    /* a still small interior               */ "s-scroll":    { file: "scroll.mp3",          gain: 0.80 },
    /* a fountain in the court, cicadas     */ "s-afternoon": { file: "palace.mp3",          gain: 0.85 }
  };
  /* The closing beat has no scene class, and an unmapped beat holds whatever is
     already playing rather than cutting to silence — so the harbour carries
     through the ending, which is what it should do anyway. */

  /* ---- tuning ----------------------------------------------------------- */
  /* The master was 0.50 / 0.32 and the beds were heard as "a little loud,
     make it a bit quieter so it's not the main focus". Halved. The target is
     that a reader is not aware of the sound until they think about it, which
     is a different thing from being able to hear it — every bed is still well
     above its own noise floor at 0.26, and the relative balance between them
     is untouched, because halving the master moves all fifteen by the same
     5.7 dB and cannot change how they sit against each other.

     One bed did not survive that uniformly: `search` is a near-silence by
     design, and 5.7 dB below a near-silence is a bed that reads as a failed
     download. Its own gain was raised to compensate — see BEDS above. That is
     the rule to follow if this number is ever lowered again: move the bed that
     falls off the bottom, not the master. */
  var LEVEL      = 0.26;   /* master, sound on                                */
  var LEVEL_CALM = 0.17;   /* master under prefers-reduced-motion             */
  var TAU        = 0.55;   /* crossfade time constant, seconds — see ramp()   */
  var STOP_AFTER = 2800;   /* ms after a fade-out before the voice is freed   */
  var CACHE_MAX  = 3;      /* decoded beds held at once                       */
  var HEAD_TRIM  = 0.05;   /* seconds skipped at the loop head — see play()   */
  var TAIL_TRIM  = 0.10;   /* seconds skipped at the loop tail                */

  var K_ON   = "fb-sound";       /* "on" | "off"                              */
  var K_HINT = "fb-sound-hint";  /* the silent-switch note, shown once ever   */

  /* ------------------------------------------------------------------------
     Bail out silently on anything that cannot possibly work. No control, no
     listeners, no console noise — a page that never offered sound.
     ------------------------------------------------------------------------ */
  var AC = window.AudioContext || window.webkitAudioContext;
  var deck = document.getElementById("deck");
  if (!AC || !window.fetch || !window.Promise || !window.MutationObserver || !deck) return;

  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function calm() {
    return (mq && mq.matches) ||
           document.documentElement.classList.contains("no-motion");
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
  var everLoaded = false, probed = false, hinted = !!recall(K_HINT);
  var liveKey = null;
  var hideTimer = 0, noteTimer = 0;
  var unwake = function () {};      /* set below if a choice was remembered   */

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
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    return ctx;
  }

  /* A crossfade wants equal power, and the textbook answer is
     setValueCurveAtTime with a cosine pair. It is the wrong answer here: a
     reader flicking through beats fires overlapping fades, and a curve that
     overlaps a scheduled event throws, mid-story, on the audio thread.
     setTargetAtTime cannot collide — it always starts from wherever the value
     actually is right now and approaches exponentially. Two uncorrelated
     ambient beds crossfaded exponentially dip by well under a decibel in the
     middle, which nobody has ever heard. Robustness wins. */
  function ramp(param, target) {
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

  function load(key) {
    if (!key || !BEDS[key] || !ctx) return Promise.resolve(null);
    if (buffers[key]) { touch(key); return Promise.resolve(buffers[key]); }
    if (failed[key])  return Promise.resolve(null);      /* never retried     */
    if (loading[key]) return loading[key];

    var p = fetch(BASE + BEDS[key].file, { credentials: "omit" })
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
        buffers[key] = b; everLoaded = true; touch(key); return b;
      })
      .catch(function () { failed[key] = 1; return null; })
      .then(function (b) { delete loading[key]; return b; });

    loading[key] = p;
    return p;
  }

  function play(key) {
    var bed = BEDS[key], buf = buffers[key];
    if (!bed || !buf || !ctx) return;

    var v = voices[key];
    if (v) {                       /* still fading out — catch it and lift it */
      if (v.kill) { clearTimeout(v.kill); v.kill = 0; }
      ramp(v.gain.gain, bed.gain);
      return;
    }

    var g = ctx.createGain();
    g.gain.value = 0;
    g.connect(master);

    var s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    /* MP3 decoding adds encoder delay at the head and padding at the tail, and
       no browser strips it consistently — looping the whole buffer therefore
       ticks once per lap. Looping inside the file steps over both. The beds are
       built noise-like precisely so this small jump has nothing tonal to
       break; see AUDIO.md. */
    s.loopStart = Math.min(HEAD_TRIM, buf.duration * 0.02);
    s.loopEnd   = Math.max(s.loopStart + 0.5, buf.duration - TAIL_TRIM);
    s.connect(g);
    try { s.start(0, s.loopStart); } catch (e) { try { s.start(0); } catch (e2) { return; } }

    voices[key] = { gain: g, src: s, kill: 0 };
    ramp(g.gain, bed.gain);
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

  /* ------------------------------------------------------------------------
     Which bed a beat wants
     ------------------------------------------------------------------------ */
  function keyOf(page) {
    if (!page) return null;
    var sc = page.querySelector(".scene");
    if (!sc) return null;
    var cl = sc.classList;
    for (var i = 0; i < cl.length; i++) if (BEDS[cl[i]]) return cl[i];
    return null;
  }
  function livePage() { return deck.querySelector(".page.live"); }

  function nextKeyAfter(page) {
    var n = page && page.nextElementSibling;
    while (n) { var k = keyOf(n); if (k) return k; n = n.nextElementSibling; }
    return null;
  }
  function anyOtherKey(not) {
    var pages = deck.children;
    for (var i = 0; i < pages.length; i++) {
      var k = keyOf(pages[i]);
      if (k && k !== not) return k;
    }
    return null;
  }

  function go(key) {
    if (!key) return;                 /* unmapped beat: hold, do not go quiet */
    fadeAllBut(key);
    if (buffers[key]) { play(key); afterFirstSound(); }
    else load(key).then(function (b) {
      if (!b || !on || liveKey !== key) return;
      play(key);
      afterFirstSound();
    });
    var nxt = nextKeyAfter(livePage());
    if (nxt && nxt !== key) load(nxt);          /* one beat of read-ahead     */
  }

  /* The observer fires on any class change under the deck — a sheet opening, an
     answer being marked — so this stays cheap and returns early. Between beats
     there is briefly no `.live` page at all; holding the current bed through
     that gap is what stops the sound flickering on every swipe. */
  function sync() {
    var k = keyOf(livePage());
    if (!k || k === liveKey) return;
    liveKey = k;
    if (on) go(k);
  }
  new MutationObserver(sync).observe(deck, {
    subtree: true, attributes: true, attributeFilter: ["class"]
  });
  sync();
  requestAnimationFrame(sync);        /* the shell sets the first .live in rAF */

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
    if (r && r.catch) r.catch(function () {});

    ramp(master.gain, level());
    if (!liveKey) liveKey = keyOf(livePage());
    go(liveKey);
    probe();
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
     rather than one so that a single missing bed cannot retire the whole
     system.
     ------------------------------------------------------------------------ */
  function probe() {
    if (probed || everLoaded) return;
    probed = true;
    var a = liveKey || anyOtherKey(null);
    var b = anyOtherKey(a);
    Promise.all([load(a), load(b)]).then(function () {
      if (!everLoaded) retire("No sound available");
      else paint();                 /* drop the busy pulse once anything lands */
    });
  }

  function retire(msg) {
    dead = true; on = false; armed = false;
    forget(K_ON);                       /* do not re-arm on the next reload   */
    if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
    btn.className = "fb-sound is-dead";
    say(msg, 2600);                     /* the label used to carry this       */
    btn.setAttribute("aria-disabled", "true");
    btn.removeAttribute("aria-pressed");
    setTimeout(function () {
      btn.classList.add("is-gone");
      setTimeout(function () {
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        if (note.parentNode) note.parentNode.removeChild(note);
      }, 400);
    }, 2600);
  }

  /* ------------------------------------------------------------------------
     The silent switch.

     iOS mutes Web Audio when the hardware switch on the side of the phone is
     set to silent. There is no API that reports it: an AnalyserNode sees the
     graph, not the speaker, so the page cannot know. All we can do is make the
     one-second conclusion "this is broken" into "oh — the switch", the moment
     sound actually starts. Once per device, then never again.
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
     The control
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
    /* The label states the state, not the action — "Sound off" is what is true
       right now. The button's accessible name says what a press will do. */
    /* No words — see css. The state still has a name for anyone who cannot
       see the icon: aria-pressed and aria-label, below. */
    btn.setAttribute("aria-pressed", String(on || armed));
    btn.setAttribute("aria-label", (on || armed) ? "Ambient sound is on. Turn it off."
                                                 : "Ambient sound is off. Turn it on.");
  }

  btn.addEventListener("click", function (e) {
    e.preventDefault();
    if (dead) return;
    if (on || armed) turnOff(); else turnOn();
  });

  paint();
  document.body.appendChild(btn);
  document.body.appendChild(note);

  /* ------------------------------------------------------------------------
     On by default.

     The story is written to be heard, so sound is on unless the reader turned
     it off — `recall(K_ON) !== "off"` rather than `=== "on"`.

     It still cannot start by itself. Every browser blocks audio until the page
     has had a real gesture, and iOS is strictest; nothing is fetched or decoded
     until then either. So the control shows the state it is about to be in and
     waits, busy, for the first touch — which on a deck you scroll is the
     reader's first swipe, a second in. A page that tried and failed would look
     exactly like a page that never tried, so it does not try.
     ------------------------------------------------------------------------ */
  if (recall(K_ON) !== "off") {
    armed = true;
    paint();
    var EVENTS = ["pointerdown", "touchend", "mousedown", "keydown"];
    var wake = function (e) {
      /* Not the button's own tap — that is a deliberate "off", and the click
         listener above owns it. */
      if (!armed || (e && e.target && e.target.closest && e.target.closest(".fb-sound"))) return;
      turnOn();
    };
    unwake = function () {
      armed = false;
      for (var i = 0; i < EVENTS.length; i++)
        document.removeEventListener(EVENTS[i], wake, true);
    };
    for (var i = 0; i < EVENTS.length; i++)
      document.addEventListener(EVENTS[i], wake, true);
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
      if (r && r.catch) r.catch(function () {});
      ramp(master.gain, level());
    }
  });
  window.addEventListener("pagehide", function () {
    if (ctx) { try { ctx.suspend(); } catch (e) {} }
  });

  /* If the reader turns reduced motion on mid-read, follow it. */
  if (mq) {
    var reflect = function () { if (on && ctx) ramp(master.gain, level()); };
    mq.addEventListener ? mq.addEventListener("change", reflect) : mq.addListener(reflect);
  }
})();
