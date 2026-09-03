/* ==========================================================================
   Factbox — the two boxes on the support page.   Exposes: window.FBSP

   Both hand the message to the reader's own mail app, addressed to
   hello@factbox.app with the subject and body already written. Nothing posts
   anywhere: this site has no server that can send mail, and a form that
   silently drops what someone typed is worse than one that visibly hands it
   over.

   Neither will send without an email address in it. A support message from an
   unknown sender cannot be answered, which makes it a message into a bin.

   ES5, guarded. If this file never runs the page is still every answer and a
   working mailto link in the footer.
   ========================================================================== */

var FBSP = (function () {
  "use strict";

  var TO = "hello@factbox.app";

  function el(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function val(n) { try { return (n && n.value ? String(n.value) : "").replace(/^\s+|\s+$/g, ""); } catch (e) { return ""; } }
  function show(n, on) { try { if (n) n.hidden = !on; } catch (e) {} }
  function say(n, t) { try { if (n) { n.textContent = t; n.hidden = !t; } } catch (e) {} }

  /* Deliberately loose. The point is to catch a typo and an empty box, not to
     argue with anyone about what a valid address looks like — the strict
     patterns reject real addresses and the reader has no way to win. */
  function looksLikeEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  function wire(opts) {
    var form = el(opts.form), msg = el(opts.msg), from = el(opts.from), err = el(opts.err);
    if (!form) return;
    form.addEventListener("submit", function (ev) {
      try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) {}
      say(err, "");
      var body = val(msg), who = val(from);

      if (!body) { say(err, opts.emptyMsg); try { msg.focus(); } catch (e) {} return; }
      if (!who) { say(err, "We need your email, or there is nowhere to reply."); try { from.focus(); } catch (e) {} return; }
      if (!looksLikeEmail(who)) { say(err, "That email does not look right — check it and try again."); try { from.focus(); } catch (e) {} return; }

      var text = body + "\n\n—\nFrom: " + who + "\nSent from " + opts.where;
      var href = "mailto:" + TO +
        "?subject=" + encodeURIComponent(opts.subject) +
        "&body=" + encodeURIComponent(text);
      try { if (window.FB && FB.track) FB.track(opts.event); } catch (e) {}
      try { location.href = href; } catch (e) {
        say(err, "Could not open your mail app. Write to " + TO + " instead.");
      }
    }, false);
  }

  function boot() {
    wire({ form: "sp-help", msg: "sp-msg", from: "sp-from", err: "sp-help-err",
           subject: "Factbox support", event: "support_send",
           where: "the support page",
           emptyMsg: "Tell us what happened first — even one line helps." });
    wire({ form: "sp-idea", msg: "sp-idea-msg", from: "sp-idea-from", err: "sp-idea-err",
           subject: "Factbox — story idea", event: "support_idea",
           where: "the suggest-a-story box",
           emptyMsg: "Tell us what to cover first." });
  }

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, false);
    else boot();
  } catch (e) {}

  return { boot: boot, version: 1 };
})();
