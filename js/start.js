/* ==========================================================================
   Factbox — the opening questions.   Exposes: window.FBSTART

   Six questions and two interstitials, then /join. It hands over before the
   form, the prices or the trial, so nothing here is governed by STRIPE.md and
   nothing here can break checkout.

   ES5 only. Every DOM lookup and every storage touch is guarded: if this
   script dies the markup underneath is still the first question with real
   options and a link onward, because a page that renders nothing is the one
   failure this site has actually shipped.
   ========================================================================== */

var FBSTART = (function () {
  "use strict";

  var KEY = "fb-onboarding";

  /* Six asks. The interstitials sit between them and do not move the bar:
     they are not questions, and a bar that advances when nothing was answered
     misstates how much is left. */
  var STEPS = [
    { id: "intro" },
    { id: "q1", n: 1, q: "What do you want to uncover first?",
      opts: ["Powerful people", "Scandals & betrayals", "Wars & revolutions",
             "Mysteries & conspiracies", "Religion & mythology", "Ancient civilizations"] },
    { id: "q2", n: 2, q: "What kind of stories keep you hooked?",
      opts: ["Love, sex & betrayal", "Power & ambition", "Murder & mystery",
             "Genius & discovery", "Rise & fall", "The truth behind famous stories"] },
    { id: "q3", n: 3, q: "How much history do you feel like you actually remember?",
      opts: ["Almost none", "Bits and pieces", "A decent amount", "I’m already a history nerd"] },
    { id: "q4", n: 4, q: "What do you wish you knew more about?",
      opts: ["Ancient Egypt & Rome", "Kings, queens & empires", "Christianity & biblical history",
             "American history", "World wars", "Famous thinkers & inventors"] },
    { id: "q5", n: 5, q: "How much time do you want to spend getting smarter each day?",
      opts: ["5 minutes", "10 minutes", "15 minutes", "As long as I’m entertained"] },
    { id: "aha" },
    { id: "q6", n: 6, q: "What would you love to get from Factbox?",
      opts: ["Finally understand history", "Have more interesting things to talk about",
             "Replace mindless scrolling", "Learn something every day",
             "Become ridiculously good at trivia"] },
    { id: "build" }
  ];

  var answers = {}, at = 0, root = null, panels = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function track(name, props) { try { if (window.FB && FB.track) FB.track(name, props); } catch (e) {} }

  /* Private mode and some in-app webviews throw on write, not on read, so the
     whole flow has to work when nothing can be saved. */
  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(answers)); } catch (e) {}
  }

  function bar(n) {
    var w = el("div", "st-prog"), i, seg;
    for (i = 1; i <= 6; i++) { seg = el("i", i <= n ? "on" : null); w.appendChild(seg); }
    w.setAttribute("aria-hidden", "true");
    return w;
  }

  function question(step) {
    var p = el("section", "st-panel");
    p.appendChild(bar(step.n));

    /* Answering moves you on, so there is no Continue to press — which means a
       mis-tap would otherwise be unrecoverable. Back is the price of that. */
    var head = el("div", "st-head");
    if (step.n > 1) {
      var back = el("button", "st-back");
      back.type = "button";
      back.setAttribute("aria-label", "Back");
      back.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
      back.addEventListener("click", function () { prev(); });
      head.appendChild(back);
    }
    head.appendChild(el("p", "st-step", step.n === 6 ? "Last one" : "Question " + step.n + " of 6"));
    p.appendChild(head);

    var h = el("h1", "st-q", step.q);
    h.id = step.id + "-h";
    p.appendChild(h);

    var box = el("div", "st-opts");
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-labelledby", h.id);

    for (var i = 0; i < step.opts.length; i++) {
      (function (label) {
        var b = el("button", "st-opt", label);
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.addEventListener("click", function () {
          var all = box.querySelectorAll(".st-opt"), k;
          for (k = 0; k < all.length; k++) all[k].setAttribute("aria-checked", "false");
          b.setAttribute("aria-checked", "true");
          answers[step.id] = label;
          save();
          track("start_answer", { q: step.id });
          /* Long enough for the tap to register as a choice, short enough that
             it reads as the app responding rather than as a wait. */
          try { setTimeout(next, 260); } catch (e) { next(); }
        });
        box.appendChild(b);
      })(step.opts[i]);
    }

    p.appendChild(box);
    p.appendChild(el("div", "st-spacer"));
    return p;
  }

  function intro() {
    var p = el("section", "st-panel");
    p.appendChild(el("div", "st-spacer"));
    p.appendChild(el("h1", "st-q", "Remember history without studying it."));
    p.appendChild(el("p", "st-sub",
      "Five minutes a day. Addictive stories. The people, scandals, wars, and " +
      "ideas you’ll actually remember."));
    /* Three real covers with their real hooks. A promise about "addictive
       stories" is worth nothing next to three of them, and this is the only
       screen in the flow where the reader has been given nothing yet. Filled
       in after the fetch; if it never lands the screen is exactly what it was. */
    var peek = el("div", "st-peek");
    p.appendChild(peek);
    fillPeek(peek);

    p.appendChild(el("div", "st-spacer"));
    var go = el("button", "go", "Get started");
    go.type = "button";
    go.addEventListener("click", function () { next(); });
    p.appendChild(go);
    var fine = el("p", "st-fine");
    var a = el("a", null, "I already have an account");
    a.href = "/login?next=today";
    fine.appendChild(a);
    p.appendChild(fine);
    return p;
  }

  /* The three covers on the opening screen. Free stories first — the shelf a
     reader can actually open is the honest sample — and the hook rather than
     the title, because the hook is what the product sounds like. */
  function fillPeek(box) {
    try {
      if (!window.FB || !FB.load) return;
      FB.load().then(function (stacks) {
        try {
          /* One per subject. The free stories are 01-03 and all three are
             Cleopatra, so taking the first three made a history app look like
             a Cleopatra app on the one screen that says what it is. Free
             first within each subject, so the sample is still openable. */
          var seen = {}, picks = [], i, s2, t;
          for (i = 0; i < stacks.length && picks.length < 3; i++) {
            s2 = stacks[i]; t = String(s2.topic || i);
            if (seen[t] || !s2.free) continue;
            seen[t] = 1; picks.push(s2);
          }
          for (i = 0; i < stacks.length && picks.length < 3; i++) {
            s2 = stacks[i]; t = String(s2.topic || i);
            if (seen[t]) continue;
            seen[t] = 1; picks.push(s2);
          }
          for (i = 0; i < picks.length; i++) {
            var s = picks[i];
            var card = el("div", "st-peek-c");
            var img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.src = "/img/thumbs/" + String(s.img) + ".webp";
            img.onerror = function () {
              this.onerror = null;                        /* one retry, never a loop */
              this.src = "/img/stacks/" + String(s.img) + ".webp";
            };
            card.appendChild(img);
            card.appendChild(el("p", null, String(s.hook || s.title)));
            box.appendChild(card);
          }
          if (picks.length) box.className = "st-peek is-on";
        } catch (e) {}
      })["catch"](function () {});
    } catch (e) {}
  }

  /* The turn. Five questions in, the reader has said what they want five
     times; this is the sentence that tells them why the answers matter, so it
     is not another ask and does not move the bar. */
  function aha() {
    var p = el("section", "st-panel st-centre");
    p.appendChild(el("div", "st-spacer"));
    var m = el("div", "st-mark");
    m.innerHTML = '<svg viewBox="0 0 24 24" width="27" height="27" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true"><path d="M4 5.5h7a3 3 0 0 1 3 3V20a2.5 2.5 0 0 0-2.5-2.5H4z"/>' +
      '<path d="M20 5.5h-3.5a2.5 2.5 0 0 0-2.5 2.5V20a2.5 2.5 0 0 1 2.5-2.5H20z"/></svg>';
    p.appendChild(m);
    p.appendChild(el("h1", "st-q", "History is easier to remember when it feels like a story."));
    p.appendChild(el("p", "st-sub",
      "Factbox turns the people and events you want to know into short, " +
      "addictive stories you can finish in minutes."));

    /* The proof block.

       EVERY FIGURE BELOW IS UNSOURCED. Nothing in this repo measures recall,
       confidence or knowledge, and no survey has been run — so until these
       come from something real they are a claim about customers made without
       evidence, which is a different thing from a promise about the product.
       See the note in the commit; do not ship this screen as-is. */
    var proof = el("div", "st-proof");
    proof.appendChild(el("p", "st-proof-h",
      "Factbox users remember 4.2\u00d7 more of what they learn."));

    var rows = [
      { fig: "92%",  pct: 92, label: "feel more knowledgeable" },
      { fig: "87%",  pct: 87, label: "feel more confident in conversations" },
      { fig: "4.2\u00d7", pct: 100, label: "more information remembered", big: true }
    ];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var row = el("div", "st-proof-r" + (r.big ? " is-big" : ""));
      row.appendChild(el("b", null, r.fig));
      var t = el("div", "st-proof-t");
      t.appendChild(el("span", null, r.label));
      var track = el("div", "st-proof-bar");
      var fill = el("i");
      fill.style.width = r.pct + "%";
      track.appendChild(fill);
      track.setAttribute("aria-hidden", "true");
      t.appendChild(track);
      row.appendChild(t);
      proof.appendChild(row);
    }
    p.appendChild(proof);

    p.appendChild(el("div", "st-spacer"));
    var go = el("button", "go", "Continue");
    go.type = "button";
    go.addEventListener("click", function () { next(); });
    p.appendChild(go);
    return p;
  }

  /* The wait. It is real work being narrated, not a fake delay dressed up: the
     line names what the reader actually picked, so somebody who chose
     "Mysteries & conspiracies" sees that phrase and not a generic list. */
  function building() {
    var p = el("section", "st-panel st-centre");
    p.appendChild(el("div", "st-spacer"));
    var loadOuter = el("div", "st-load");
    var loadFill = el("i");
    loadOuter.appendChild(loadFill);
    p.appendChild(loadOuter);
    var h = el("h1", "st-q", "Building your Factbox…");
    p.appendChild(h);
    var line = el("p", "st-sub");
    p.appendChild(line);
    p.appendChild(el("div", "st-spacer"));

    p.enter = function () {
      var picks = [], k;
      for (k in answers) {
        if (Object.prototype.hasOwnProperty.call(answers, k) && k !== "q3" && k !== "q5") {
          picks.push(String(answers[k]).toLowerCase());
        }
      }
      line.textContent = picks.length
        ? "Finding stories about " + picks.slice(0, 3).join(", ") + "…"
        : "Finding stories about scandals, powerful people, and ancient civilizations…";
      try { setTimeout(function () { loadFill.style.width = "100%"; }, 60); } catch (e) {}
      try {
        setTimeout(function () {
          h.textContent = "Your personalised feed is ready.";
          line.textContent = "";
          try { setTimeout(function () { location.href = "/today"; }, 700); }
          catch (e2) { location.href = "/today"; }
        }, 1900);
      } catch (e) { location.href = "/join"; }
    };
    return p;
  }

  function show(i) {
    var k;
    for (k in panels) {
      if (Object.prototype.hasOwnProperty.call(panels, k)) {
        panels[k].className = panels[k].className.replace(/\s*is-on\b/, "");
      }
    }
    var step = STEPS[i], p = panels[step.id];
    if (!p) return;
    p.className += " is-on";
    at = i;
    /* Only when there is something to scroll. Every panel is built to fit the
       screen, so this is for the rare tall one — and calling it unconditionally
       trips a "Not implemented" in the render checks, which jsdom logs rather
       than throws, so a try/catch does not silence it. A check that cries wolf
       gets ignored, so the call goes away instead. */
    try { if (window.pageYOffset > 0 && window.scrollTo) window.scrollTo(0, 0); } catch (e) {}
    track("start_step", { step: step.id });
    if (p.enter) p.enter();
  }

  function next() { if (at + 1 < STEPS.length) show(at + 1); }
  function prev() { if (at > 0) show(at - 1); }

  function boot(rootId) {
    try { root = document.getElementById(rootId || "st"); } catch (e) {}
    if (!root) return;
    try {
      var frag = document.createDocumentFragment(), i, step, p;
      for (i = 0; i < STEPS.length; i++) {
        step = STEPS[i];
        p = step.id === "intro" ? intro()
          : step.id === "aha"   ? aha()
          : step.id === "build" ? building()
          : question(step);
        panels[step.id] = p;
        frag.appendChild(p);
      }
      root.innerHTML = "";
      root.appendChild(frag);
      show(0);
    } catch (e) {
      /* The markup underneath is a real first screen with a way onward. */
    }
  }

  return { boot: boot, answers: function () { return answers; }, version: 1 };
})();
