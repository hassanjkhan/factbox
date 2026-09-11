#!/usr/bin/env python3
"""
providers.py — the two paid services, called directly over HTTPS.

NO SDK, NO CLI, NO MCP SERVER. Neither service ships an official CLI, and
each of these is one HTTP call, so a dependency would add a supply chain
without adding a capability. Specifically avoided:

  higgsfield-mcp (npm)   third party — published by `souvik04` / Storyvord,
                         not by Higgsfield, ~226 downloads a week. An MCP
                         server is handed the API key on every call. Not a
                         package to trust with a billable credential.
  higgsfield (PyPI)      unrelated. A distributed-training library that
                         happens to share the name.
  elevenlabs-mcp (PyPI)  genuinely official (authored from an elevenlabs.io
                         address), but built for interactive agent use. A
                         batch pipeline wants the endpoint, not a server.

KEYS LIVE OUTSIDE THE REPO, in ~/.factbox-keys/. The repo is public. Nothing
here ever prints a key, and a key must never be pasted into a chat — the
PostHog key that went into a transcript is still on the board waiting to be
rotated, which is the whole argument.
"""

import json, os, sys, time, urllib.request, urllib.error

KEYS = os.path.expanduser("~/.factbox-keys")
# Higgsfield sits behind Cloudflare, which rejects Python's default
# User-Agent outright: every request comes back "error code: 1010" no matter
# which header or path is used, which reads exactly like a bad credential and
# is not. A normal browser UA is the whole fix.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")
EL_HOST = "https://api.elevenlabs.io"
HF_HOST = "https://api.higgsfield.ai"


def load_key(name, required):
    """Read ~/.factbox-keys/<name>.json and check the fields we depend on are
    actually there, so a missing one fails now with a useful sentence rather
    than as a 401 in the middle of a paid batch."""
    path = os.path.join(KEYS, name + ".json")
    if not os.path.exists(path):
        raise SystemExit(
            "missing %s\n"
            "  Create it with the fields: %s\n"
            "  It lives outside the repo on purpose — the repo is public."
            % (path, ", ".join(required)))
    cfg = json.load(open(path))
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        raise SystemExit("%s is missing: %s" % (path, ", ".join(missing)))
    return cfg


def _req(url, data=None, headers=None, method=None, timeout=180):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"))
    r.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            return raw, ctype
    except urllib.error.HTTPError as e:
        detail = (e.read() or b"")[:400].decode("utf-8", "replace")
        raise SystemExit("%s %s -> %s %s" % (r.get_method(), url.split("?")[0], e.code, detail))


# ----------------------------------------------------------- elevenlabs ----

def elevenlabs_say(text, out_wav, run_cmd, probe=None):
    """One sentence, one file. We never ask for the whole script in one go,
    so the pauses ElevenLabs leaves between sentences are never created and
    there is nothing to cut out afterwards. It also means the plain endpoint
    is enough — no timestamps needed, because ffprobe measures the file."""
    cfg = load_key("elevenlabs", ["api_key", "voice_id"])
    url = "%s/v1/text-to-speech/%s" % (EL_HOST, cfg["voice_id"])
    payload = {
        "text": text,
        "model_id": cfg.get("model_id", "eleven_multilingual_v2"),
        "voice_settings": {
            "stability": cfg.get("stability", 0.40),
            "similarity_boost": cfg.get("similarity_boost", 0.75),
            "style": cfg.get("style", 0.50),
            "speed": cfg.get("speed", 1.0),
            "use_speaker_boost": cfg.get("use_speaker_boost", True),
        },
    }
    raw, ctype = _req(url, payload, {"xi-api-key": cfg["api_key"], "Accept": "audio/mpeg"})
    if b"" == raw or "json" in ctype:
        raise SystemExit("elevenlabs returned no audio: " + raw[:300].decode("utf-8", "replace"))
    mp3 = out_wav + ".mp3"
    open(mp3, "wb").write(raw)
    run_cmd(["ffmpeg", "-y", "-v", "error", "-i", mp3, "-ar", "44100", "-ac", "1", out_wav])
    os.remove(mp3)


# ----------------------------------------------------------- higgsfield ----

def _hf_headers(cfg):
    return {"Authorization": "Key %s:%s" % (cfg["key_id"], cfg["key_secret"])}


def higgsfield_upload(path):
    """Put a local image somewhere Higgsfield can read it, and return the URL.

    This is what makes a CHARACTER REFERENCE possible without the browser: one
    approved picture of the person is uploaded once, and every later scene is
    generated against it. Without a reference, twenty prompts become twenty
    different women in twenty different drawing styles, however carefully the
    appearance is described in words."""
    cfg = load_key("higgsfield", ["key_id", "key_secret"])
    ext = os.path.splitext(path)[1].lower()
    ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".webp": "image/webp"}.get(ext, "image/png")
    raw, _ = _req(HF_HOST + "/files/generate-upload-url", {"content_type": ctype},
                  _hf_headers(cfg))
    j = json.loads(raw)
    put = urllib.request.Request(j["upload_url"], data=open(path, "rb").read(),
                                 method="PUT")
    put.add_header("User-Agent", UA)
    for k, v in (j.get("upload_headers") or {}).items():
        put.add_header(k, v)
    if not (j.get("upload_headers") or {}).get("Content-Type"):
        put.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(put, timeout=180) as resp:
            if resp.status not in (200, 201, 204):
                raise SystemExit("upload returned %s" % resp.status)
    except urllib.error.HTTPError as e:
        raise SystemExit("upload failed: %s %s"
                         % (e.code, (e.read() or b"")[:200].decode("utf-8", "replace")))
    return j["public_url"]


def higgsfield_image(prompt, out_png, tag, poll_every=4, timeout=600,
                     reference_url=None):
    """Submit one prompt, wait for it, save the image.

    The guard that matters: the tag (SHOT 07) must appear in the prompt we
    send, exactly once. The browser version of this workflow could silently
    fail to enter a prompt and then re-submit the PREVIOUS one, paying twice
    for a duplicate. Over the API that cannot happen — but the check is kept
    because it also catches a prompts file that has drifted out of step with
    the timeline, which is the same failure with a different cause.
    """
    cfg = load_key("higgsfield", ["key_id", "key_secret"])
    ref = str(cfg.get("custom_reference_id") or "")
    locked = bool(ref) and "PASTE" not in ref
    # A character sheet has no shot to belong to, so there is nothing to check.
    if tag and prompt.count(tag) != 1:
        raise SystemExit("prompt for %s does not carry its tag exactly once — refusing "
                         "to spend a credit on an ambiguous prompt" % tag)
    # enhance_prompt defaults OFF. It rewrites the prompt before generation,
    # and a rewrite is where negative constraints go to die: shot 01 came back
    # with the exact heavy black wig the style guide forbids by name. The
    # style guide only works if it arrives verbatim.
    #
    # soul/character needs a locked character; soul/standard does not. Without
    # a reference id the written appearance block in the prompt carries the
    # consistency on its own — which the manual workflow found matters MORE
    # than the reference slot anyway, since the reference thumbnail is too
    # small to tell two similar faces apart.
    # soul/reference anchors every frame to one approved picture — the
    # character AND the drawing style come from it. That is the whole reason
    # a set holds together. soul/character does the same through a reference
    # locked in the UI; soul/standard has nothing to hold on to at all.
    if reference_url:
        endpoint = "/higgsfield-ai/soul/reference"
    elif locked:
        endpoint = "/higgsfield-ai/soul/character"
    else:
        endpoint = "/higgsfield-ai/soul/standard"
    body = {
        "prompt": prompt,
        "aspect_ratio": cfg.get("aspect_ratio", "9:16"),
        "resolution": cfg.get("resolution", "1080p"),
        "enhance_prompt": cfg.get("enhance_prompt", False),
    }
    if reference_url:
        body["image_reference_url"] = reference_url
        body["num_images"] = 1
    elif locked:
        body["custom_reference_id"] = ref
        body["custom_reference_strength"] = cfg.get("custom_reference_strength", 0.8)
        body["batch_size"] = 1
    else:
        body["num_images"] = 1
    if cfg.get("style_id"):
        body["style_id"] = cfg["style_id"]
        body["style_strength"] = cfg.get("style_strength", 1.0)
    if cfg.get("seed"):
        body["seed"] = int(cfg["seed"])

    raw, _ = _req(HF_HOST + endpoint, body, _hf_headers(cfg))
    job = json.loads(raw)
    rid = job.get("request_id") or job.get("id")
    if not rid:
        raise SystemExit("higgsfield gave no request id: " + raw[:300].decode("utf-8", "replace"))

    waited = 0
    while waited < timeout:
        time.sleep(poll_every)
        waited += poll_every
        raw, _ = _req("%s/requests/%s/status" % (HF_HOST, rid), None, _hf_headers(cfg))
        st = json.loads(raw)
        status = st.get("status")
        if status == "completed":
            urls = [i.get("url") for i in (st.get("images") or []) if i.get("url")]
            if not urls:
                return {"ok": False, "why": "completed with no image"}
            data, _ = _req(urls[0], None, None, "GET")
            open(out_png, "wb").write(data)
            return {"ok": True, "request_id": rid}
        if status in ("failed", "canceled", "nsfw"):
            # nsfw is the content filter, and it is predictable once you have
            # seen it: decadent banquet, flirting, the latrine, a defeated
            # gladiator. Reword flat and historical. Failures refund credits,
            # so a re-run is cheap — but it is never automatic, because a
            # silent retry is how a bug turns into a bill.
            return {"ok": False, "why": status, "error": st.get("error"),
                    "hint": ("content filter — reword toward flat historical description"
                             if status == "nsfw" else None)}
    return {"ok": False, "why": "timed out after %ds" % timeout}


# ---------------------------------------------------------------- check ----

def check():
    """Prove both keys work before a real run, and spend nothing doing it.

    Higgsfield has NO endpoint to create or list characters — the OpenAPI spec
    exposes only the endpoints that consume custom_reference_id. So the
    character stays a thing made in their UI, and the id has to be lifted out
    of it. If that proves impossible, soul/reference takes a plain
    image_reference_url instead and needs no id at all.
    """
    ok = True

    # --- ElevenLabs ---------------------------------------------------------
    # A key can be created with a narrow scope, and a scoped key is a GOOD key.
    # "missing_permissions" therefore proves the credential is valid and only
    # says this particular door is shut; "invalid_api_key" is the real failure.
    # What has to work is text-to-speech, so that is what gets checked last.
    try:
        cfg = load_key("elevenlabs", ["api_key", "voice_id"])
        hdr = {"xi-api-key": cfg["api_key"]}
        valid = None
        try:
            raw, _ = _req(EL_HOST + "/v1/user", None, hdr, "GET", 30)
            sub = (json.loads(raw).get("subscription") or {})
            print("  elevenlabs key   : ok   tier=%s  used %s/%s characters"
                  % (sub.get("tier", "?"), sub.get("character_count", "?"),
                     sub.get("character_limit", "?")))
            valid = True
        except SystemExit as e:
            if "missing_permissions" in str(e):
                print("  elevenlabs key   : ok   (valid, without the user_read scope — "
                      "cannot show your credit balance, nothing else affected)")
                valid = True
            elif "invalid_api_key" in str(e) or " 401" in str(e):
                print("  elevenlabs key   : REJECTED — the key itself is wrong")
                valid = False
            else:
                raise

        if valid:
            try:
                raw, _ = _req(EL_HOST + "/v1/voices/" + cfg["voice_id"], None, hdr, "GET", 30)
                print("  elevenlabs voice : ok   \"%s\"" % json.loads(raw).get("name", "?"))
            except SystemExit as e:
                if "missing_permissions" in str(e):
                    print("  elevenlabs voice : cannot verify (no voices_read scope) — "
                          "the first sentence generated will prove it")
                elif " 404" in str(e):
                    print("  elevenlabs voice : NOT FOUND — check the voice_id")
                    ok = False
                else:
                    raise
            # the only permission that actually matters
            try:
                raw, ctype = _req(EL_HOST + "/v1/text-to-speech/" + cfg["voice_id"],
                                  {"text": "Test.", "model_id": cfg.get("model_id",
                                   "eleven_multilingual_v2")},
                                  dict(hdr, **{"Accept": "audio/mpeg"}), None, 60)
                print("  text-to-speech   : ok   (%d bytes of audio for a 5-character test)"
                      % len(raw))
            except SystemExit as e:
                print("  text-to-speech   : FAILED — %s" % str(e)[:150])
                ok = False
        else:
            ok = False
    except SystemExit as e:
        print("  elevenlabs       : %s" % e)
        ok = False

    # --- Higgsfield: ask about a request that cannot exist ------------------
    # 404 means the credential was accepted and the id simply is not there,
    # which is exactly what we want to learn. 401/403 means the key is wrong.
    try:
        cfg = load_key("higgsfield", ["key_id", "key_secret"])
        probe_id = "00000000-0000-0000-0000-000000000000"
        try:
            _req("%s/requests/%s/status" % (HF_HOST, probe_id), None, _hf_headers(cfg), "GET", 30)
            print("  higgsfield key   : ok")
        except SystemExit as e:
            msg = str(e)
            if " 404" in msg or "not found" in msg.lower():
                print("  higgsfield key   : ok   (auth accepted)")
            elif " 401" in msg or " 403" in msg:
                print("  higgsfield key   : REJECTED — check key_id and key_secret")
                ok = False
            else:
                print("  higgsfield key   : unclear — %s" % msg[:120])
        ref = str(cfg.get("custom_reference_id") or "")
        if ref and "PASTE" not in ref:
            print("  higgsfield char  : locked character set — soul/character")
        else:
            print("  higgsfield char  : NO locked character yet — will use soul/standard "
                  "and carry the look in the written prompt")
    except SystemExit as e:
        print("  higgsfield       : %s" % e)
        ok = False

    return ok
