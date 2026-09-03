# Explore

There is no Explore page any more, and this file is mostly a redirect.

`/` and `/explore` serve the same page — the home page. It is built by
`js/today.js` and styled by `css/today.css`, and it carries Today's Factbox,
Trending now, and Binge a series. The nav has two tabs, Explore and Library;
there is no Home tab, because the page you land on is the home page.

What used to be here — a search row, "Pick an obsession" chips, and eighteen
shelves — is gone. It was a second answer to the question the home page was
already answering.

## What js/explore.js still is

The season's own names for things, and nothing else. It publishes:

```js
window.FBTAX = { TOPICS: {...}, KINDS: {...} }
```

`TOPICS` maps a stack's `topic` key to a display name and a `lower` form for
mid-sentence use. `KINDS` does the same for `kind`. Both are read at call time
rather than at load, because `js/recommend.js` may run before this file has
defined them.

This is the one place a subject is named. `js/recommend.js`, `js/today.js` and
the end card all read it, and each carries its own fallback copy in case the
file is missing — so a rename has to happen here first, and the fallbacks have
to follow. "Devils, saints and heresies" became "Saints and sinners" that way.

The `lower` form exists because the end card says "There's more to X". A
possessive does not work across all eight subjects: "devils, saints and
heresies's story" and "disasters's story" are not sentences. Naming the subject
after a preposition reads correctly for every one of them.
