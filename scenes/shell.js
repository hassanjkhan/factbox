/* ==========================================================================
   Factbox reader — shell
   Builds the page stack from STORIES, hosts the scenes, runs the caption
   choreography, and owns the one class both halves of this build key off:
   `.live` on the current `.page`.
   ========================================================================== */

/* --------------------------------------------------------------------------
   Reduced motion. Set before first paint so scenes never animate a frame they
   should not have. The scenes read `html.no-motion`.
   -------------------------------------------------------------------------- */
(function () {
  var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  var apply = function () { document.documentElement.classList.toggle("no-motion", mq.matches); };
  apply();
  mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply);
})();

/* --------------------------------------------------------------------------
   Pin the page height.

   100% of traffic arrives from Instagram / TikTok, so most readers are in an
   in-app webview whose chrome hides and shows as they scroll — which resizes
   the viewport by 40-90px mid-swipe. If `.page` height tracked that live,
   every page in a mandatory-snap stack would reflow under the reader's thumb
   and the browser would re-resolve the snap target, jumping them to a
   different beat. So: measure once on first paint, pin it, and only re-pin on
   a real orientation change — then restore the beat they were on.
   -------------------------------------------------------------------------- */
/* Arms the caption animation. Until this lands, captions are plain visible,
   so a script that fails or is still parsing never leaves a blank card. */
document.documentElement.classList.add("js");

var pinnedH = 0, pinnedW = 0;
/* Measure only to detect a real orientation change. The height itself comes
   from `100dvh` in CSS — pinning a px value here is what produced a deck
   shorter than the screen, with the body showing through beneath it. */
function pinHeight() {
  pinnedH = window.innerHeight;
  pinnedW = window.innerWidth;
}
pinHeight();

/* --------------------------------------------------------------------------
   Story data.
   One story = one array of beats. Each beat names the scene class it wants;
   the shell finds that scene in the bank and hosts it. More stories drop in
   here and the picker below hands a visitor a random one — which is the
   experiment: same link, different story, see which one finishes.
   -------------------------------------------------------------------------- */
const STORIES = {
  "cleopatra-death": {
    title: "How did Cleopatra die?",
    cards: [
      { scene:'s-door', h:'How did Cleopatra die?',
        b:'The snake is in every painting of her, and nobody has ever found it.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Strabo, <i>Geography</i> — 17.1.8–10. A Greek geographer in Egypt within a few years of 30 BC', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-fleet', h:'Cleopatra’s kingdom of Egypt is falling.',
        b:'In 30 BCE, Octavian invades Alexandria, Egypt.',
        note:'He is not yet Augustus — he took that name in 27 BCE, three years after this.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Cassius Dio, <i>Roman History</i> — Books 50–51, early 3rd century AD', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-harbour', h:'They barricade themselves inside the royal palace.',
        b:'Marc Antony, Cleopatra’s lover, and Cleopatra, who ruled Alexandria at the time, shut themselves in.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Cassius Dio, <i>Roman History</i> — Books 50–51, early 3rd century AD', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-triumph', h:'Cleopatra chooses to be immortalized as a queen.',
        b:'She knows that if she is captured by her opponent Octavian, he will parade her in Rome as a trophy, humiliating her and ending her legacy. She refuses to be displayed as a conquered queen.',
        note:'She never was. Octavian held the triumph in 29 BCE and carried an effigy of her in it instead — a figure of the queen with the snakes on her.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Cassius Dio, <i>Roman History</i> — 51.21.8, on the effigy carried in the triumph', 'Joyce Tyldesley, <i>Cleopatra: Last Queen of Egypt</i> — Profile Books, 2008'] },
      { scene:'s-bath', h:'Cleopatra chooses death on her own terms.',
        b:'Ancient sources say that she took a bath, dressed in royal attire, and ate a final meal.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Cassius Dio, <i>Roman History</i> — Books 50–51, early 3rd century AD', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-letter', h:'She writes a letter to Octavian.',
        b:'She asks to be buried with Antony.',
        note:'Not alone — Plutarch has two of her women, Iras and Charmion, dying with her. That is part of why the snake account is doubted: one asp, three deaths.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Cassius Dio, <i>Roman History</i> — Books 50–51, early 3rd century AD', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-copies', h:'The great debate: the snake.',
        b:'Plutarch, a Greek biographer writing more than a century after Cleopatra’s death, recorded a story that an asp, a venomous snake, was smuggled into her mausoleum hidden beneath figs in a basket.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-scroll', h:'He wasn’t an eyewitness.',
        b:'He never revealed the original source of the story. He was compiling earlier accounts and traditions that have since been lost.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Strabo, <i>Geography</i> — 17.1.8–10. A Greek geographer in Egypt within a few years of 30 BC', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-basket', h:'If there was a snake, she let it bite her.',
        b:'That is how the story goes. But even Plutarch admitted no one actually knew how Cleopatra died, so the famous snake-and-fig-basket story is a possibility, not established fact.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Strabo, <i>Geography</i> — 17.1.8–10. A Greek geographer in Egypt within a few years of 30 BC', 'Horace, <i>Odes</i> I.37 — written within a year or two of her death; the earliest mention of the serpents'] },
      { scene:'s-mausoleum', h:'Some historians believe she may have used poison instead.',
        b:'A palace with physicians on hand had quieter options than a snake nobody could produce.',
        src:['Christoph Schäfer, <i>Kleopatra</i> — WBG, 2006 — argues for a drug mixture rather than a snake', 'Joyce Tyldesley, <i>Cleopatra: Last Queen of Egypt</i> — Profile Books, 2008', 'Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010'] },
      { scene:'s-painting', h:'Weavers put it in anyway.',
        b:'This Flemish tapestry was made around 1650. The snake is on her arm, and the Latin woven above her says she took it so she would not be led through Rome.',
        note:'The Death of Cleopatra, designed by Justus van Egmont, woven by Geraert van der Strecken, Brussels, 1650–77. The Metropolitan Museum of Art, released under CC0.',
        src:['Walker &amp; Higgs (eds), <i>Cleopatra of Egypt: From History to Myth</i> — British Museum Press, 2001', 'The Metropolitan Museum of Art — collection record, Open Access (CC0)'] },
      { scene:'s-coil', h:'So how did she die?',
        q:{ options:['A snake was smuggled in to her','Nobody has ever established it'], correct:1 },
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Strabo, <i>Geography</i> — 17.1.8–10. A Greek geographer in Egypt within a few years of 30 BC', 'Joyce Tyldesley, <i>Cleopatra: Last Queen of Egypt</i> — Profile Books, 2008'] },
      { scene:'s-search', result:true, h:'Nobody has ever established it.',
        b:'The guards searched the room and found no snake. Two faint marks on her arm are all anyone claimed to see.',
        src:['Plutarch, <i>Life of Antony</i> — chs. 84–86. Written c. 110 AD, roughly 140 years later', 'Strabo, <i>Geography</i> — 17.1.8–10. A Greek geographer in Egypt within a few years of 30 BC', 'Cassius Dio, <i>Roman History</i> — Books 50–51, early 3rd century AD'] },
      { scene:'s-pharos', h:'Legacy.',
        b:'Cleopatra dies at 39 years old. Egypt became a Roman province, ending about 275 years of rule under Cleopatra’s family.',
        note:'Ptolemaic rule ran from 305 to 30 BCE — 275 years, not 300.',
        src:['Duane W. Roller, <i>Cleopatra: A Biography</i> — Oxford University Press, 2010', 'Cassius Dio, <i>Roman History</i> — Books 50–51, early 3rd century AD', 'Joyce Tyldesley, <i>Cleopatra: Last Queen of Egypt</i> — Profile Books, 2008'] },
    ]
  }
};

/* Same link, random story. Sticky per visitor so a reload doesn't reshuffle
   and ruin the read. */
const KEYS = Object.keys(STORIES);
let slug = new URLSearchParams(location.search).get("s");
if (!KEYS.includes(slug)) {
  try { slug = sessionStorage.getItem("fb-story"); } catch (e) { slug = null; }
  if (!KEYS.includes(slug)) slug = KEYS[Math.floor(Math.random() * KEYS.length)];
}
try { sessionStorage.setItem("fb-story", slug); } catch (e) {}
const STORY = STORIES[slug];
if (STORY.title) document.title = STORY.title;

/* Where completion + signups go. Empty until the site is on its own domain
   and a real endpoint exists — see the note in the handover. */
const ENDPOINT = "";
function track(event, extra) {
  const payload = Object.assign({ event, story: slug, t: Date.now() }, extra || {});
  if (!ENDPOINT) { console.info("[factbox]", payload); return; }
  try {
    navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], {type:"application/json"}));
  } catch (e) {}
}

/* -------------------------------------------------------------------------- */

const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const deck = document.getElementById("deck");
const rail = document.getElementById("rail");
const bank = document.getElementById("scene-bank");

/* Lift a scene out of the bank by its class. A beat whose scene has not been
   built yet still composes — it gets a neutral night ground instead. */
function takeScene(name) {
  const found = bank && bank.querySelector("." + name);
  if (found) {
    /* Clone rather than move: two beats may hold the same shot. */
    const node = found.cloneNode(true);
    node.classList.add("scene");            /* belt and braces, per contract */
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  const ph = document.createElement("div");
  ph.className = "scene scene-missing " + name;
  ph.setAttribute("aria-hidden", "true");
  return ph;
}

/* Caption elements animate in sequence: headline, then the supporting line a
   beat later, then everything under it. */
function stage(cap) {
  let d = 0.06;
  [...cap.children].forEach(el => {
    el.classList.add("rise");
    el.style.setProperty("--d", d.toFixed(2) + "s");
    d += 0.12;
  });
}

function buildPage(c, i) {
  const page = document.createElement("section");
  page.className = "page";
  page.dataset.i = i;

  page.appendChild(takeScene(c.scene));

  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.setAttribute("aria-hidden", "true");
  page.appendChild(scrim);

  const wrap = document.createElement("div");
  wrap.className = "capwrap";
  const cap = document.createElement("div");
  cap.className = "cap";

  if (c.result) page.dataset.result = "1";

  let inner = c.result
    ? `<div class="verdict"></div><h2 class="hl">${esc(c.h)}</h2>`
    : `<h2 class="hl">${esc(c.h)}</h2>`;
  if (c.b) inner += `<p class="sub">${esc(c.b)}</p>`;

  if (c.tl) inner += '<div class="tl">' + c.tl.map(([w, x]) =>
      `<div class="row"><span class="when">${esc(w)}</span><span class="what">${esc(x)}</span></div>`).join("") + "</div>";

  if (c.relic) inner += `<div class="relic"><div class="obj">${esc(c.relic.obj)}</div>` +
      `<div class="prov">${esc(c.relic.prov)}</div><div class="proves">${esc(c.relic.proves)}</div></div>`;

  if (c.q) inner += '<div class="q"><div class="opts">' + c.q.options.map((o, n) =>
      `<button class="opt" type="button" data-n="${n}"><span class="mark"></span>${esc(o)}</button>`).join("") +
      `</div><div class="reveal">${esc(c.q.reveal)}</div></div>`;

  if (c.note) inner += `<div class="note">${esc(c.note)}</div>`;

  cap.innerHTML = inner;
  stage(cap);
  wrap.appendChild(cap);
  page.appendChild(wrap);

  /* Sources. Every card cites where it came from — that is the product. It
     lives as a pill on the picture that raises a sheet over the scene, so it
     costs the full-bleed look one small affordance and nothing else. */
  if (c.src) {
    const btn = document.createElement("button");
    btn.className = "srcbtn";
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = `${c.src.length} source${c.src.length > 1 ? "s" : ""} <span class="chev">▲</span>`;

    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.innerHTML = '<div class="grab"></div><h3>Sources</h3>' +
      (c.credit ? `<p class="credit">${esc(c.credit)}</p>` : "") +
      `<ol>${c.src.map(s => `<li>${s}</li>`).join("")}</ol>`;

    page.appendChild(btn);
    page.appendChild(sheet);
  }

  if (i === 0) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.setAttribute("aria-hidden", "true");
    hint.innerHTML = '<span class="arrow"></span><span>Swipe up</span>';
    page.appendChild(hint);
  }

  return page;
}

STORY.cards.forEach((c, i) => {
  deck.appendChild(buildPage(c, i));
  rail.appendChild(document.createElement("i"));
});

/* The ending. Thirteen more stories exist; this is where they are offered.
   The subscribe button goes to a Stripe Payment Link — a hosted checkout URL
   that needs no server and no API key, which is the whole reason this static
   site can take money at all. Set PAY below and the button goes live. */
const PAY = "";        /* Stripe Payment Link URL */

const end = document.createElement("section");
end.className = "page end";
end.innerHTML =
  '<div class="scene" aria-hidden="true"></div>' +
  '<div class="scrim" aria-hidden="true"></div>' +
  '<div class="capwrap"><div class="cap">' +
    '<div class="wordmark">Factbox</div>' +
    '<h2 class="hl">Come read more stories.</h2>' +
    '<p class="sub">Fifty more, sourced the same way. Cleopatra, the Bible, ' +
      'Rome, and the people we have flattened into statues.</p>' +
    '<div class="shelf"><a class=\'shelfcard isfree\' href=\'read.html?s=02\'><span class=\'shelfplate\'><img src=\'img/thumbs/s02.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'></span><em>Cleopatra the seductress</em></a><a class=\'shelfcard\' href=\'read.html?s=05\'><span class=\'shelfplate\'><img src=\'img/thumbs/s05.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>The Ark of the Covenant</em></a><a class=\'shelfcard\' href=\'read.html?s=09\'><span class=\'shelfplate\'><img src=\'img/thumbs/s09.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Chernobyl</em></a><a class=\'shelfcard\' href=\'read.html?s=14\'><span class=\'shelfplate\'><img src=\'img/thumbs/s14.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Timeline of the Book of Revelation</em></a><a class=\'shelfcard\' href=\'read.html?s=22\'><span class=\'shelfplate\'><img src=\'img/thumbs/s22.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Galatians 5: the fruit test</em></a><a class=\'shelfcard\' href=\'read.html?s=26\'><span class=\'shelfplate\'><img src=\'img/thumbs/s26.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>The Gnostics</em></a><a class=\'shelfcard\' href=\'read.html?s=31\'><span class=\'shelfplate\'><img src=\'img/thumbs/s31.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Alexander the Great&#39;s missing tomb</em></a><a class=\'shelfcard\' href=\'read.html?s=32\'><span class=\'shelfplate\'><img src=\'img/thumbs/s32.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Joan of Arc</em></a><a class=\'shelfcard\' href=\'read.html?s=39\'><span class=\'shelfplate\'><img src=\'img/thumbs/s39.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Napoleon wasn&#39;t short</em></a><a class=\'shelfcard\' href=\'read.html?s=43\'><span class=\'shelfplate\'><img src=\'img/thumbs/s43.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Rasputin wouldn&#39;t die</em></a><a class=\'shelfcard\' href=\'read.html?s=44\'><span class=\'shelfplate\'><img src=\'img/thumbs/s44.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>Genghis Khan&#39;s hidden grave</em></a><a class=\'shelfcard\' href=\'read.html?s=50\'><span class=\'shelfplate\'><img src=\'img/thumbs/s50.webp\' alt=\'\' loading=\'lazy\' decoding=\'async\'><i class=\'shelflock\' aria-hidden=\'true\'>&#128274;</i></span><em>The Ides of March</em></a></div>' +
    '<button class="go pay" id="pay" type="button">Read the rest of the stories</button>' +
    '<p class="fine">Sign up first &mdash; three days free before anything ' +
      'is charged.</p>' +
    '<a class="ghostlink" href="/explore">See what is inside first</a>' +
    '<p class="haveacct">Already have an account? ' +
      '<a href="/login?next=%2Fexplore">Sign in</a></p>' +
    '<p class="endfoot">' +
      '<a href="explore.html">Explore</a> &middot; <a href="library.html">Library</a> &middot; ' +
      '<a href="credits.html">Artwork credits</a> &middot; <a href="support.html">Support</a>' +
    '</p>' +
  '</div></div>';
stage(end.querySelector(".cap"));
deck.appendChild(end);

/* Park the shelf mid-row. Starting at the left edge reads as a list that
   happens to be cut off; starting in the middle reads as a row you can push
   either way, which is what it is. No smooth behaviour — this is the initial
   position, not a movement the reader should see. */
(function () {
  var shelf = end.querySelector(".shelf");
  if (!shelf) return;
  var centre = function () {
    var over = shelf.scrollWidth - shelf.clientWidth;
    if (over <= 0) return;                       /* they all fit; leave it */
    var card = shelf.querySelector(".shelfcard");
    if (!card) { shelf.scrollLeft = Math.round(over / 2); return; }
    /* Land on a cover boundary. Half a painting at the left edge is the thing
       that reads as broken, and rounding to the pitch costs nothing. */
    var pitch = card.getBoundingClientRect().width + 10;   /* + gap */
    shelf.scrollLeft = Math.round(over / 2 / pitch) * pitch;
  };
  centre();
  /* Covers are lazy, so the row's width is not final on the first frame. */
  requestAnimationFrame(centre);
  setTimeout(centre, 400);
  addEventListener("orientationchange", function () { setTimeout(centre, 250); });
})();
rail.appendChild(document.createElement("i"));

document.getElementById("pay").addEventListener("click", () => {
  track("subscribe_click", { from: "story" });
  /* Money is the last screen now, not the first. This walks to the funnel,
     which asks for an email, runs onboarding, then shows the plans. */
  location.href = "join.html?from=story";
});

/* --------------------------------------------------------------------------
   Interactions
   -------------------------------------------------------------------------- */
deck.addEventListener("click", e => {
  const s = e.target.closest(".srcbtn");
  if (s) {
    const sheet = s.parentElement.querySelector(".sheet");
    const open = !sheet.classList.contains("on");
    sheet.classList.toggle("on", open);
    s.setAttribute("aria-expanded", String(open));
    if (open) track("sources_open");
    return;
  }

  /* Tap the sheet's own backdrop area — i.e. anywhere on the scene — to close. */
  if (!e.target.closest(".sheet")) {
    const openSheet = e.target.closest(".page") && e.target.closest(".page").querySelector(".sheet.on");
    if (openSheet) {
      openSheet.classList.remove("on");
      const b = openSheet.parentElement.querySelector(".srcbtn");
      if (b) b.setAttribute("aria-expanded", "false");
    }
  }

  const o = e.target.closest(".opt");
  if (o && !o.parentElement.classList.contains("done")) {
    const wrap = o.parentElement;
    const page = o.closest(".page");
    const card = STORY.cards[Number(page.dataset.i)];
    const correct = card.q.correct;
    wrap.classList.add("done");
    [...wrap.children].forEach((b, n) => {
      b.classList.add(n === correct ? "right" : "wrong");
      b.querySelector(".mark").textContent = n === correct ? "✓" : (b === o ? "×" : "");
    });
    const got = Number(o.dataset.n) === correct;
    track("answered", { correct: got });

    /* Carry the verdict to the next beat and go there. The pause is long
       enough to see which option was yours and no longer. */
    const i = [...deck.children].indexOf(page);
    const res = deck.children[i + 1];
    if (res && res.dataset.result === "1") {
      res.querySelector(".verdict").textContent = got ? "Correct." : "Not quite.";
      res.classList.toggle("was-right", got);
      res.classList.toggle("was-wrong", !got);
    }
    setTimeout(() => goToBeat(i + 1), 620);
  }
});

/* --------------------------------------------------------------------------
   `.live` — the class the whole build turns on. The scenes run their
   animation only while their page carries it, so at most one scene is moving.
   It also drives the caption choreography and the progress rail.
   -------------------------------------------------------------------------- */
const pages = [...deck.children];
let deepest = 0;
let current = 0;

const io = new IntersectionObserver(entries => {
  entries.forEach(en => {
    en.target.classList.toggle("live", en.isIntersecting);
    if (!en.isIntersecting) return;
    const i = pages.indexOf(en.target);
    current = i;
    [...rail.children].forEach((d, n) => d.classList.toggle("on", n === i));
    if (i > deepest) {
      deepest = i;
      if (i === 1) track("started");
      if (i === pages.length - 1) track("reached_end");
    }
  });
}, { threshold: 0.6 });
pages.forEach(p => io.observe(p));

/* Start the first page on the next frame rather than waiting for the
   observer's first tick — the opening scene is painted, the headline rises
   into it, and nothing above the fold waits on anything heavy. */
[...rail.children][0].classList.add("on");
requestAnimationFrame(() => pages[0].classList.add("live"));

/* --------------------------------------------------------------------------
   Teach the gesture once, then never again.
   -------------------------------------------------------------------------- */
let hint = deck.querySelector(".hint");
deck.addEventListener("scroll", () => {
  if (hint && deck.scrollTop > 30) {
    hint.classList.add("out");
    const h = hint; hint = null;
    setTimeout(() => h.remove(), 320);
  }
}, { passive: true });

/* --------------------------------------------------------------------------
   Re-pin on a real orientation change only, and keep the reader on their beat.
   A webview hiding its chrome changes innerHeight by a few dozen px and must
   be ignored; a rotation swaps width and height.
   -------------------------------------------------------------------------- */
let repin;
window.addEventListener("resize", () => {
  /* Only a rotation matters. A webview hiding its chrome resizes the
     viewport constantly; dvh already absorbs that, and reacting to it is
     what threw the reader off their beat. */
  if (window.innerWidth === pinnedW) return;
  clearTimeout(repin);
  repin = setTimeout(() => {
    const i = current;
    pinHeight();
    /* Snap can land anywhere after a reflow — put them back where they were. */
    deck.style.scrollBehavior = "auto";
    deck.scrollTop = i * deck.clientHeight;
    requestAnimationFrame(() => { deck.style.scrollBehavior = ""; });
  }, 160);
});

if (bank && bank.parentNode) bank.parentNode.removeChild(bank);

track("open");

/* --------------------------------------------------------------------------
   Keyboard, and a guaranteed way forward.

   Scroll-snap plus a caption that can scroll means a drag does not always
   reach the deck — and on a desktop with a mouse there is no swipe at all.
   Arrow keys, page keys, space and Home/End all move a whole beat, which is
   also the accessible way through: the deck is focusable so a keyboard user
   can reach it at all.
   -------------------------------------------------------------------------- */
function beatIndex() {
  const h = deck.clientHeight || 1;
  return Math.round(deck.scrollTop / h);
}
function goToBeat(i) {
  const n = deck.children.length - 1;
  const t = Math.max(0, Math.min(n, i));
  deck.scrollTo({ top: t * deck.clientHeight, behavior: "smooth" });
}

deck.tabIndex = 0;
addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "button" ||
      tag === "a" || tag === "select" || e.target.isContentEditable) return;

  const k = e.key;
  let d = 0;
  if (k === "ArrowDown" || k === "PageDown" || k === " " || k === "Spacebar") d = 1;
  else if (k === "ArrowUp" || k === "PageUp") d = -1;
  else if (k === "Home") { e.preventDefault(); goToBeat(0); return; }
  else if (k === "End")  { e.preventDefault(); goToBeat(1e4); return; }
  else return;

  e.preventDefault();
  goToBeat(beatIndex() + d);
});

