/* ==========================================================================
   Factbox — the season's own names for things.   Exposes: window.FBTAX

   This file used to be the Explore page: a search box, two rows of filter
   chips and eighteen shelves. That page is gone. `/` and `/explore` are now
   one page — Today's Factbox, a trending shelf and one row per subject — and
   js/today.js renders it. What is left here is the part that was never about
   Explore at all: the words the site uses for its own groupings.

   The raw keys in data/index.json are how the data is filed, not how a reader
   thinks. Every name below is what someone would say out loud, and every note
   under it is a plain description of what is actually in that group — never a
   claim the stories do not make.

   THIS IS THE ONE COPY. Two tables meant one group had two names, and one of
   them was wrong ("the medieval world", over a group containing Rasputin, who
   died in 1916). So each record carries every form the site needs:

     name   the heading form            "Medieval and modern"
     lower  the mid-sentence form       "More on the medieval and modern world"
     note   what is in the group        "Joan of Arc to Rasputin"
     note1  the same note when the group holds exactly one story; omitted
            where the plural form already reads correctly for one

   KINDS carry `more`, the "read another like this one" form, for the same
   reason.

   Two files read this, neither of which may keep its own copy: js/today.js
   names the subjects on the front page from TOPICS, and js/recommend.js names
   the end-of-story recommendation from KINDS. recommend.js runs on the reader
   page, where this file is not loaded, so it keeps a fallback of its own and
   prefers this table when it is there.

   ES5 only, no DOM, no network, and it cannot throw: a table and one guarded
   assignment.
   ========================================================================== */

(function () {
  "use strict";

  var TOPICS = [
    { key: "cleopatra",      name: "Cleopatra",              lower: "Cleopatra",
      note: "her death, her tomb, her reputation" },
    { key: "new_testament",  name: "The New Testament",      lower: "the New Testament",
      note: "Jesus, Paul, Peter, Mary Magdalene" },
    { key: "church_history", name: "Saints and sinners",         lower: "saints and sinners",
      note: "what the early church argued about" },
    { key: "old_testament",  name: "The Old Testament",      lower: "the Old Testament",
      note: "the Ark, the scrolls, the kings" },
    { key: "us_history",     name: "America",                lower: "America",
      note: "Lincoln, and the night he was shot" },
    { key: "ancient_world",  name: "The ancient world",      lower: "the ancient world",
      note: "Rome, Greece, Alexander" },
    { key: "medieval_modern",name: "Medieval and modern",    lower: "the medieval and modern world",
      note: "Joan of Arc to Rasputin" },
    { key: "disaster",       name: "When it all went wrong", lower: "disasters",
      note: "disasters, hour by hour", note1: "one disaster, hour by hour" }
  ];

  var KINDS = [
    { key: "unsolved_mystery", name: "Unsolved mysteries",   more: "Another unsolved one",
      note: "nobody knows the answer" },
    { key: "myth_correction",  name: "Things you have wrong", more: "Another myth, corrected",
      note: "the version everyone repeats, checked" },
    { key: "violent_death",    name: "Deaths",               more: "Another grisly one",
      note: "how they actually died" },
    { key: "list_explainer",   name: "The whole thing, explained", more: "Another explainer",
      note: "laid out in order" },
    { key: "moral_reversal",   name: "The turn nobody mentions", more: "Another one that flips",
      note: "the part that complicates it" },
    { key: "hidden_meaning",   name: "Hidden meanings",      more: "Another hidden meaning",
      note: "what it meant to the people who wrote it" }
  ];

  /* Published rather than exported, because every consumer is an ES5 script
     that reads window. Additive: it defines one new global and redefines
     nothing. */
  try {
    if (typeof window !== "undefined") window.FBTAX = { TOPICS: TOPICS, KINDS: KINDS };
  } catch (e) {}
})();
