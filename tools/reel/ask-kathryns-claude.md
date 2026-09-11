# Question for whoever runs Higgsfield on Kathryn's machine

We're building the Factbox reel pipeline against the **Higgsfield REST API**
(cloud.higgsfield.ai), not the browser. We've hit a wall on character
consistency that you've presumably already solved from the UI side, and we'd
rather learn from you than burn credits guessing.

## What we did, and what happened

**Run 1 — `POST /higgsfield-ai/soul/standard`, no reference of any kind.**
20 prompts, one per sentence of a Cleopatra script, each ~100 words of scene
description with a shared style paragraph appended verbatim, plus a written
appearance lock ("dark brown hair worn loose, her own hair uncovered, never a
straight-cut black wig, never heavy kohl").

Result: the scenes were genuinely good — real compositions, correct staging.
But the set did not hold together at all. Frame 1 was flat ink-and-wash, frame
6 was an oil painting, frame 12 was a Victorian salon picture, and frame 5 came
back as a **19th-century ironclad steamship** where a Roman war fleet should
have been. Cleopatra's face and hair changed in every frame.

**Run 2 — one character sheet, then `POST /higgsfield-ai/soul/reference`.**
Generated a single full-length figure of Cleopatra alone on a plain background
(tight single figure, no scenery, no other people — following the advice that a
finished scene makes a bad reference). Uploaded it via
`POST /files/generate-upload-url`, then passed the returned `public_url` as
`image_reference_url` on every scene call.

Result: **every one of the 20 frames came back as a near-copy of the reference
itself** — the same woman standing on a plain background. No harbour, no
throne room, no ships, no other people. The scene prompt was ignored entirely.
We got consistency and lost the story.

**Then we tried turning the reference down.** `soul/reference` takes
`style_strength` (0–1, default 1). We re-ran one shot — "Then Julius Caesar
arrives", prompted as a Roman fleet arriving at Alexandria harbour seen from
the quayside — at **1.0, 0.55, 0.35 and 0.2**. All four are still just her
standing on a plain background. Not one contains a ship. So the strength knob
is not the lever, and our read is that `soul/reference` is image-to-image and
cannot place a character into a described scene at any setting.

## What we think the answer is, and want you to confirm or correct

We think the right endpoint is **`POST /higgsfield-ai/soul/character`** with a
`custom_reference_id` — a character locked in the Higgsfield UI. Their OpenAPI
spec has no endpoint to create or list characters, only endpoints that consume
the id, so it looks like the lock has to be made in the browser once and then
referenced from the API forever after.

## The questions

1. **Is that right?** Is `soul/character` + a UI-locked `custom_reference_id`
   the only way to get "this specific person, in an arbitrary described scene"?
   Is `soul/reference` genuinely just image-to-image?

2. **How do you create the lock, and where does its id appear?** We can make the
   character in the UI, but we need the UUID to put in an API call. Is it in the
   character page URL, or only visible in the network request when you generate?

3. **Does the lock bleed composition the way the reference URL did?** Or does a
   locked character genuinely appear inside whatever scene you describe?

4. **What `custom_reference_strength` do you actually use?** Default is 0.8 in
   our config, chosen arbitrarily. What works for you, and what breaks at each
   end?

5. **What do you feed the lock?** A tight single-figure crop on a plain
   background, or something else? Does the written appearance block still matter
   once a lock exists, or does the lock do all the work?

6. **How do you handle a second character?** Our Cleopatra script needs Cleopatra
   AND Caesar AND Antony, and `soul/character` takes one `custom_reference_id`.
   Do you lock the most-present character and describe the rest in words? Run
   separate batches? Something else?

7. **How do you get STYLE consistency across a set, separately from the
   character?** Do you use a `style_id`? Where does it come from — is it also a
   UI object? Or does the character lock carry the drawing style too?

8. **Can we see your actual style guide text, verbatim?** We have one that works
   reasonably, but yours has been through more reels than ours.

## One finding of ours that may be useful to you

`enhance_prompt` matters more than it looks, and it cuts both ways.

- **ON** (the API default): images look good, but written constraints get
  dropped. Our style guide said the character is "NEVER shown with a heavy black
  wig" and the first image came back with exactly that wig.
- **OFF**: the model follows the prompt text so literally that a style guide
  written like a *document* — ALL-CAPS headers, colons, sections — gets **drawn
  as a document**. We got a full page of gibberish Latin text with a small
  illustration inset, which also violated the "no text anywhere" rule the same
  guide was asking for.

What worked was **enhancement ON with the style guide rewritten as a single
paragraph of flowing visual prose**, every constraint phrased positively — "her
own hair worn loose, uncovered, face bare of cosmetics" rather than "never a
wig, never kohl". Negations seem to anchor rather than suppress.

## Other API notes, in case they're new to you

- The API sits behind Cloudflare and rejects Python's default User-Agent
  outright: every call returns `error code: 1010` regardless of endpoint or
  auth header, which reads exactly like a bad credential. A browser User-Agent
  is the whole fix.
- Cloud credits are **separate** from the higgsfield.ai app subscription. The
  app showed 10 credits while the API reported `not_enough_credits`.
- 20 of 20 generations succeeded with no content-filter rejections, against the
  15–20% failure rate we were expecting.
