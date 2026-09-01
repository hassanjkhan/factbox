/* Render a built page in a real DOM and assert the words are on it.
   Every check that passed while the site was shipping wordless was a check
   that never executed the script. This one does. */
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs"), path = require("path");

const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(e.message + "\n" + (e.stack || "").split("\n")[1]));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: "https://factbox.app/" + path.basename(file),
  beforeParse(w) {
    /* jsdom ships neither of these. Absent, the script throws on a line that
       works perfectly in every real browser, which would be a false alarm. */
    w.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; this.els = []; }
      observe(el) { this.els.push(el); }
      unobserve() {} disconnect() {}
      /* Report the first page as fully visible, which is what a phone does. */
      fire() { this.cb(this.els.map((t, i) => ({ target: t, isIntersecting: i === 0 })), this); }
    };
    w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q,
      addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }));
    const noop = () => ({ connect(){}, start(){}, stop(){}, gain:{value:0,
      setValueAtTime(){}, linearRampToValueAtTime(){} }, frequency:{value:0,setValueAtTime(){}} });
    w.AudioContext = w.webkitAudioContext = class {
      constructor(){ this.destination={}; this.currentTime=0; this.state="suspended"; }
      createGain(){return noop()} createOscillator(){return noop()}
      createBufferSource(){return noop()} createBiquadFilter(){return noop()}
      createBuffer(){return {getChannelData:()=>new Float32Array(1)}}
      decodeAudioData(){return Promise.resolve({})} resume(){return Promise.resolve()}
      suspend(){return Promise.resolve()} close(){return Promise.resolve()}
    };
    w.fetch = () => Promise.reject(new Error("network disabled in check"));
  },
});

setTimeout(() => {
  const d = dom.window.document;
  const deck = d.getElementById("deck");
  const pages = deck ? [...deck.children] : [];
  // let the observer tick the way a browser would
  try { dom.window.__io && dom.window.__io.fire(); } catch (e) {}

  const live = d.querySelectorAll(".page.live, .live").length;
  const caps = [...d.querySelectorAll(".cap")];
  const withText = caps.filter(c => (c.textContent || "").trim().length > 12);
  const first = caps[0] ? caps[0].textContent.trim().replace(/\s+/g, " ").slice(0, 90) : "(no .cap)";

  console.log("script errors     :", errors.length ? errors : "none");
  console.log("pages built       :", pages.length);
  console.log("captions with text:", withText.length, "/", caps.length);
  console.log("elements .live    :", live);
  console.log("first caption     :", first);

  const ok = errors.length === 0 && pages.length > 5 && withText.length >= pages.length - 2 && live > 0;
  console.log(ok ? "\nPASS — the page has words on it." : "\nFAIL");
  process.exit(ok ? 0 : 1);
}, 1200);
