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


def higgsfield_image(prompt, out_png, tag, poll_every=4, timeout=600):
    """Submit one prompt, wait for it, save the image.

    The guard that matters: the tag (SHOT 07) must appear in the prompt we
    send, exactly once. The browser version of this workflow could silently
    fail to enter a prompt and then re-submit the PREVIOUS one, paying twice
    for a duplicate. Over the API that cannot happen — but the check is kept
    because it also catches a prompts file that has drifted out of step with
    the timeline, which is the same failure with a different cause.
    """
    cfg = load_key("higgsfield", ["key_id", "key_secret", "custom_reference_id"])
    if prompt.count(tag) != 1:
        raise SystemExit("prompt for %s does not carry its tag exactly once — refusing "
                         "to spend a credit on an ambiguous prompt" % tag)
    body = {
        "prompt": prompt,
        "custom_reference_id": cfg["custom_reference_id"],
        "custom_reference_strength": cfg.get("custom_reference_strength", 0.8),
        "aspect_ratio": cfg.get("aspect_ratio", "9:16"),
        "resolution": cfg.get("resolution", "1080p"),
        "batch_size": 1,
        "enhance_prompt": cfg.get("enhance_prompt", True),
    }
    if cfg.get("style_id"):
        body["style_id"] = cfg["style_id"]
        body["style_strength"] = cfg.get("style_strength", 1.0)
    if cfg.get("seed"):
        body["seed"] = int(cfg["seed"])

    raw, _ = _req(HF_HOST + "/higgsfield-ai/soul/character", body, _hf_headers(cfg))
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

    # --- ElevenLabs: the key and the voice, both free to ask about ---------
    try:
        cfg = load_key("elevenlabs", ["api_key", "voice_id"])
        raw, _ = _req(EL_HOST + "/v1/user", None, {"xi-api-key": cfg["api_key"]}, "GET", 30)
        u = json.loads(raw)
        sub = u.get("subscription") or {}
        used = sub.get("character_count")
        cap = sub.get("character_limit")
        print("  elevenlabs key   : ok   tier=%s%s"
              % (sub.get("tier", "?"),
                 ("  used %s/%s characters" % (used, cap)) if cap else ""))
        raw, _ = _req(EL_HOST + "/v1/voices/" + cfg["voice_id"], None,
                      {"xi-api-key": cfg["api_key"]}, "GET", 30)
        v = json.loads(raw)
        print("  elevenlabs voice : ok   \"%s\"" % v.get("name", "?"))
    except SystemExit as e:
        print("  elevenlabs       : %s" % e)
        ok = False

    # --- Higgsfield: ask about a request that cannot exist ------------------
    # 404 means the credential was accepted and the id simply is not there,
    # which is exactly what we want to learn. 401/403 means the key is wrong.
    try:
        cfg = load_key("higgsfield", ["key_id", "key_secret", "custom_reference_id"])
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
        print("  higgsfield char  : custom_reference_id set (only a real generation "
              "can prove it is the right one)")
    except SystemExit as e:
        print("  higgsfield       : %s" % e)
        ok = False

    return ok
