/* ==========================================================================
   Factbox — owner unlock.

   READ THIS BEFORE TRUSTING IT.

   This is a convenience, not a security control, and it cannot be one. The
   site is static files on GitHub Pages: everything here is delivered to the
   browser, so the digest below is public and anyone determined can bypass this
   in seconds — by brute-forcing a guessable passphrase, or simply by setting
   the unlock flag in localStorage by hand.

   That costs us nothing *today*, because there is nothing to protect: the full
   text of all 51 stories already sits in data/stacks.json, which any visitor
   can fetch. This exists so the owner can get past their own paywall on a new
   phone without paying, and so a demo does not require a Stripe checkout.

   The day the content actually needs protecting, the answer is a server that
   checks a session before serving the text. See SPEC.md §9 and the backend
   section of the launch notes.

   TO CHANGE THE PASSPHRASE
     python3 -c "import hashlib;print(hashlib.sha256(b'your-new-phrase').hexdigest())"
   and paste the result into DIGEST below. Nothing else changes.
   ========================================================================== */

var FBO = (function () {
  "use strict";

  var DIGEST = "4cd9f2f343df76be7e393eef9da6c7041e163724a80aacce7d636a54cace9de6";
  var MARK   = "fb_owner_v1";

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v); return v;
    } catch (e) { return null; }
  }

  /* --- SHA-256 -----------------------------------------------------------
     Web Crypto is the real implementation, but it is only available in a
     secure context and returns a promise. This compact fallback keeps the
     page working on http://localhost and in older webviews. Both produce the
     same digest, so a passphrase set with one verifies with the other. */
  function sha256(msg) {
    var K = [], H = [], i, j, p = 2, n = 0;
    function isPrime(x) { for (var d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; }
    for (p = 2, n = 0; n < 64; p++) {
      if (!isPrime(p)) continue;
      K[n] = (Math.pow(p, 1 / 3) % 1 * 4294967296) | 0;
      if (n < 8) H[n] = (Math.pow(p, 1 / 2) % 1 * 4294967296) | 0;
      n++;
    }
    var bytes = [], c;
    for (i = 0; i < msg.length; i++) {
      c = msg.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) bytes.push(192 | c >> 6, 128 | c & 63);
      else bytes.push(224 | c >> 12, 128 | (c >> 6) & 63, 128 | c & 63);
    }
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (i = 7; i >= 0; i--) bytes.push((i < 4 ? bitLen / Math.pow(2, i * 8) : 0) & 255);

    function rr(x, s) { return (x >>> s) | (x << (32 - s)); }
    var w = [], a, b, cc, d, e, f, g, h, t1, t2;
    for (i = 0; i < bytes.length; i += 64) {
      for (j = 0; j < 16; j++) {
        w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) |
               (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3];
      }
      for (j = 16; j < 64; j++) {
        var s0 = rr(w[j - 15], 7) ^ rr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        var s1 = rr(w[j - 2], 17) ^ rr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      a = H[0]; b = H[1]; cc = H[2]; d = H[3]; e = H[4]; f = H[5]; g = H[6]; h = H[7];
      for (j = 0; j < 64; j++) {
        t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[j] + w[j]) | 0;
        t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = "";
    for (i = 0; i < 8; i++) out += ("00000000" + (H[i] >>> 0).toString(16)).slice(-8);
    return out;
  }

  function check(phrase) {
    try { return sha256(String(phrase || "").trim()) === DIGEST; }
    catch (e) { return false; }
  }

  /* Unlocking reuses the normal access path, so owner mode and a real purchase
     are the same state to every other part of the site. */
  function grant() {
    try {
      if (window.FBP && FBP.unlock) FBP.unlock();
      localStorage.setItem("fb_unlocked_v1", "1");
    } catch (e) {}
    store(MARK, "1");
    return isOwner();
  }

  function isOwner() { return store(MARK) === "1"; }

  function revoke() {
    try {
      localStorage.removeItem(MARK);
      localStorage.removeItem("fb_unlocked_v1");
      if (window.FBP && FBP.lock) FBP.lock();
    } catch (e) {}
  }

  /* ?k=<phrase> on any page that loads this file, so a bookmark is one tap. */
  function claimFromURL() {
    try {
      var m = /[?&]k=([^&#]+)/.exec(location.search);
      if (!m) return false;
      var ok = check(decodeURIComponent(m[1].replace(/\+/g, " ")));
      if (ok) grant();
      try { history.replaceState({}, "", location.pathname); } catch (e) {}
      return ok;
    } catch (e) { return false; }
  }

  return { check: check, grant: grant, revoke: revoke, isOwner: isOwner,
           claimFromURL: claimFromURL, sha256: sha256 };
})();
