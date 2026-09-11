#!/usr/bin/env python3
"""
capcut.py — write a CapCut project with everything already laid out.

The point: a script goes in one end and a CapCut project comes out the other,
with the images in cut order, the voice underneath, and the captions timed to
the speech. What is left is the part that actually needs a person — swapping a
weak frame, holding a beat, judging the whole thing.

HOW, AND WHY THIS WAY
CapCut's project format is undocumented and versioned; authoring one from a
guessed schema is how you get a project that opens empty. So this does not
author from a spec — it CLONES a real draft this machine has already opened
successfully and swaps the contents. Every segment keeps the prototype's
shape, including the ten extra_material_refs a photo segment carries (speed,
placeholder, hsl, canvas, animation, channel mapping, colour, loudness, vocal
separation, time marks); each is deep-copied with a fresh id so no two
segments share state.

Three files matter:
  draft_info.json       the timeline — tracks, segments, materials
  draft_meta_info.json  what the project is, and which files it depends on
  root_meta_info.json   the project LIST. A draft not registered here exists
                        on disk and is invisible in the app.

Written against CapCut 163.0.0 (draft version 360000). A major CapCut update
can change the format; if a generated project stops opening, that is the
first thing to suspect. The pipeline's mp4 render is the fallback and does
not depend on any of this.
"""

import copy, json, os, random, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.expanduser(
    "~/Movies/CapCut/User Data/Projects/com.lveditor.draft")
US = 1000000  # CapCut counts in microseconds

# Captions are set in CapCut's OWN bundled face, not a vendored one. A draft
# that references a font from outside the app opens with the font silently
# substituted; this one is guaranteed present wherever CapCut is.
CAPCUT_FONT = ("/Applications/CapCut.app/Contents/Resources/Font/SystemFont/"
               "CapCutSansText-Bold.otf")
CAPTION_SIZE = 9.0        # CapCut's own units, not points
CAPTION_Y = -0.72         # low in frame, clear of the phone UI at the bottom


def uid():
    h = "%032X" % random.getrandbits(128)
    return "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])


def us(seconds):
    return int(round(seconds * US))


PREFIX = "factbox_"


def pick_template(projects=PROJECTS):
    """The template must contain a photo, an audio clip and a caption, because
    those are the three shapes being cloned. Prefer the draft that has all
    three and the most photos to copy from.

    Drafts we generated are skipped. They score highest — a generated reel has
    more photos than any hand-made project — so without this the tool picks
    its own last output as the template and then deletes it out from under
    itself while rebuilding. A clone must only ever be taken from a project
    CapCut itself wrote."""
    best, best_score = None, -1
    for name in sorted(os.listdir(projects)):
        if name.startswith(PREFIX):
            continue
        f = os.path.join(projects, name, "draft_info.json")
        if not os.path.exists(f):
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        photos = [v for v in d.get("materials", {}).get("videos", [])
                  if v.get("type") == "photo"]
        audios = d.get("materials", {}).get("audios", [])
        texts = d.get("materials", {}).get("texts", [])
        if not (photos and audios and texts):
            continue
        score = len(photos)
        if score > best_score:
            best, best_score = (f, d), score
    if not best:
        raise SystemExit(
            "no CapCut draft on this machine contains a photo, an audio clip and a\n"
            "caption together — there is nothing to clone from. Open CapCut, make a\n"
            "one-minute project with an image, a sound and a text layer, save it, and\n"
            "run this again.")
    return best


def _index(materials):
    """id -> which bucket it lives in."""
    home = {}
    for bucket, items in materials.items():
        if isinstance(items, list):
            for it in items:
                if isinstance(it, dict) and it.get("id"):
                    home[it["id"]] = bucket
    return home


def _clone_extras(tpl_materials, home, ref_ids, out_materials):
    """Deep-copy each referenced extra material under a fresh id, so segments
    never share mutable state. Returns the new ref list."""
    new_refs = []
    for rid in ref_ids:
        bucket = home.get(rid)
        if not bucket:
            continue
        src = next((x for x in tpl_materials[bucket]
                    if isinstance(x, dict) and x.get("id") == rid), None)
        if src is None:
            continue
        c = copy.deepcopy(src)
        c["id"] = uid()
        out_materials.setdefault(bucket, []).append(c)
        new_refs.append(c["id"])
    return new_refs


def _stage_assets(run_dir, doc, folder):
    """Copy every image and the voice into the draft folder.

    CapCut is sandboxed. It cannot read ~/factbox, or anywhere else it was not
    explicitly granted, and a draft pointing there opens with "Couldn't find
    some of the imported media files — 0/70 linked". Its own projects keep
    media inside the draft (that is what the ##_draftpath_placeholder_## paths
    in a real draft are), so we do the same. It also makes the project
    portable: the folder carries everything it needs."""
    md = os.path.join(folder, "materials")
    os.makedirs(md, exist_ok=True)
    mapping = {}
    for s in doc["shots"]:
        src = os.path.abspath(os.path.join(run_dir, s["image"]))
        if not os.path.exists(src):
            continue
        dst = os.path.join(md, os.path.basename(src))
        if not os.path.exists(dst):
            shutil.copyfile(src, dst)
        mapping[s["i"]] = dst
    vsrc = os.path.abspath(os.path.join(run_dir, "voice.wav"))
    vdst = os.path.join(md, "voice.wav")
    if os.path.exists(vsrc):
        shutil.copyfile(vsrc, vdst)
    # Each sentence goes in as its OWN file. The merged voice.wav is still
    # written for the mp4 render, but the timeline gets one clip per sentence
    # so a sentence can be dragged, held or retimed with the image it belongs
    # to. One welded audio blob makes every one of those edits a razor cut
    # first.
    voices = {}
    for b in doc["beats"]:
        src = os.path.abspath(os.path.join(run_dir, b.get("audio", "")))
        if not b.get("audio") or not os.path.exists(src):
            continue
        dst = os.path.join(md, os.path.basename(src))
        shutil.copyfile(src, dst)
        voices[b["n"]] = dst
    return mapping, vdst, voices


def build(run_dir, doc, project_name, projects=PROJECTS, captions=True):
    tpl_path, tpl = pick_template(projects)
    TM = tpl["materials"]
    home = _index(TM)

    # --- prototypes, taken from a project CapCut has really opened ---------
    photo_m = next(v for v in TM["videos"] if v.get("type") == "photo")
    photo_seg = _seg_for(tpl, photo_m["id"], "video")
    audio_m = TM["audios"][0]
    audio_seg = _seg_for(tpl, audio_m["id"], "audio")
    text_m = TM["texts"][0]
    text_seg = _seg_for(tpl, text_m["id"], "text")
    if not (photo_seg and audio_seg and text_seg):
        raise SystemExit("template %s is missing a photo, audio or text SEGMENT"
                         % os.path.dirname(tpl_path))

    folder = os.path.join(projects, project_name)
    if os.path.exists(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    staged, voice_path, voices = _stage_assets(run_dir, doc, folder)

    out = copy.deepcopy(tpl)
    # every managed bucket starts empty; anything we do not rebuild is cleared
    # so nothing can dangle against an id that no longer exists
    for bucket, items in list(out["materials"].items()):
        if isinstance(items, list):
            out["materials"][bucket] = []
    M = out["materials"]

    total = doc["duration"]
    out["id"] = uid()
    out["duration"] = us(total)
    out["fps"] = 30.0
    out["canvas_config"] = {"ratio": "original", "width": 1080, "height": 1920,
                            "background": None}
    out["keyframes"] = tpl.get("keyframes", {})
    out["name"] = ""
    out["relationships"] = []

    # ------------------------------------------------------------- images --
    vsegs = []
    for i, s in enumerate(doc["shots"]):
        img = staged.get(s["i"])
        if not img:
            continue
        m = copy.deepcopy(photo_m)
        m["id"] = uid()
        m["path"] = img
        m["material_name"] = os.path.basename(img)
        m["width"], m["height"] = 1080, 1920
        m["has_audio"] = False
        m["crop_scale"] = 1.0
        m["matting"] = copy.deepcopy(photo_m.get("matting", {}))
        if isinstance(m.get("matting"), dict):
            m["matting"]["path"] = ""
            m["matting"]["custom_matting_id"] = ""
        M.setdefault("videos", []).append(m)

        seg = copy.deepcopy(photo_seg)
        seg["id"] = uid()
        seg["material_id"] = m["id"]
        seg["extra_material_refs"] = _clone_extras(
            TM, home, photo_seg.get("extra_material_refs", []), M)
        seg["target_timerange"] = {"start": us(s["start"]), "duration": us(s["dur"])}
        seg["source_timerange"] = {"start": 0, "duration": us(s["dur"])}
        seg["render_index"] = i
        seg["track_render_index"] = 0
        seg["speed"] = 1.0
        seg["volume"] = 1.0
        seg["visible"] = True
        seg["clip"] = {"scale": {"x": 1.0, "y": 1.0}, "rotation": 0.0,
                       "transform": {"x": 0.0, "y": 0.0},
                       "flip": {"vertical": False, "horizontal": False},
                       "alpha": 1.0}
        seg["uniform_scale"] = {"on": True, "value": 1.0}
        seg["common_keyframes"] = []
        seg["keyframe_refs"] = []
        vsegs.append(seg)

    # -------------------------------------------------------------- voice --
    asegs = []
    for b in doc["beats"]:
        src = voices.get(b["n"])
        if not src:
            continue
        am = copy.deepcopy(audio_m)
        am["id"] = uid()
        am["path"] = src
        am["name"] = "%02d" % b["n"]
        am["duration"] = us(b["dur"])
        am["music_id"] = ""
        M.setdefault("audios", []).append(am)
        seg = copy.deepcopy(audio_seg)
        seg["id"] = uid()
        seg["material_id"] = am["id"]
        seg["extra_material_refs"] = _clone_extras(
            TM, home, audio_seg.get("extra_material_refs", []), M)
        seg["target_timerange"] = {"start": us(b["start"]), "duration": us(b["dur"])}
        seg["source_timerange"] = {"start": 0, "duration": us(b["dur"])}
        seg["speed"] = 1.0
        seg["volume"] = 1.0
        seg["common_keyframes"] = []
        seg["keyframe_refs"] = []
        asegs.append(seg)
    if not asegs:
        raise SystemExit("no per-sentence audio staged — run the voice stage first")

    # ----------------------------------------------------------- captions --
    tsegs = []
    if captions:
        proto_content = json.loads(text_m["content"])
        for i, b in enumerate(doc["beats"]):
            tm = copy.deepcopy(text_m)
            tm["id"] = uid()
            content = copy.deepcopy(proto_content)
            content["text"] = b["text"]
            # One style spanning the whole line. The prototype can carry several
            # ranges from whatever it was cloned from, and leaving them in means
            # the first few characters are styled differently from the rest.
            styles = content.get("styles") or [{}]
            st = copy.deepcopy(styles[0])
            st["range"] = [0, len(b["text"])]
            st["size"] = CAPTION_SIZE
            st["bold"] = True
            st["italic"] = False
            st["useLetterColor"] = True
            st["fill"] = {"alpha": 1.0, "content": {"render_type": "solid",
                          "solid": {"alpha": 1.0, "color": [1.0, 1.0, 1.0]}}}
            # A white caption over a pale illustration is unreadable without
            # this. The outline is what makes it land on ANY frame.
            st["strokes"] = [{"alpha": 1.0, "width": 0.08,
                              "content": {"render_type": "solid",
                                          "solid": {"alpha": 1.0,
                                                    "color": [0.0, 0.0, 0.0]}}}]
            st["font"] = {"id": "", "path": CAPCUT_FONT}
            content["styles"] = [st]
            tm["content"] = json.dumps(content)
            tm["base_content"] = b["text"]
            M.setdefault("texts", []).append(tm)

            ts = copy.deepcopy(text_seg)
            ts["id"] = uid()
            ts["material_id"] = tm["id"]
            ts["extra_material_refs"] = _clone_extras(
                TM, home, text_seg.get("extra_material_refs", []), M)
            ts["target_timerange"] = {"start": us(b["start"]),
                                      "duration": us(b["end"] - b["start"])}
            ts["clip"] = {"scale": {"x": 1.0, "y": 1.0}, "rotation": 0.0,
                          "transform": {"x": 0.0, "y": CAPTION_Y},
                          "flip": {"vertical": False, "horizontal": False},
                          "alpha": 1.0}
            ts["uniform_scale"] = {"on": True, "value": 1.0}
            ts["source_timerange"] = None
            ts["render_index"] = 14000 + i
            ts["common_keyframes"] = []
            ts["keyframe_refs"] = []
            tsegs.append(ts)

    # -------------------------------------------------------------- tracks --
    def track(kind, segs, idx):
        return {"attribute": 0, "flag": 0, "id": uid(), "is_default_name": True,
                "name": "", "segments": segs, "type": kind}

    out["tracks"] = [track("video", vsegs, 0), track("audio", asegs, 1)]
    if tsegs:
        out["tracks"].append(track("text", tsegs, 2))

    # ---------------------------------------------------------- on to disk --
    out["path"] = folder
    with open(os.path.join(folder, "draft_info.json"), "w") as fh:
        json.dump(out, fh)

    meta = _meta(tpl_path, folder, project_name, doc, run_dir, us(total),
                 staged, voice_path, voices)
    with open(os.path.join(folder, "draft_meta_info.json"), "w") as fh:
        json.dump(meta, fh)

    _register(projects, folder, project_name, meta["draft_id"], us(total))
    return folder, len(vsegs), len(tsegs), len(asegs)


def _seg_for(draft, material_id, kind):
    for t in draft.get("tracks", []):
        if t.get("type") != kind:
            continue
        for s in t.get("segments", []):
            if s.get("material_id") == material_id:
                return s
    return None


def _meta(tpl_path, folder, name, doc, run_dir, duration_us, staged, voice_path,
          voices):
    """draft_meta_info.json — what the project is, and every file it leans on.
    CapCut uses the materials list to know what to re-link when a file moves."""
    tpl = json.load(open(os.path.join(os.path.dirname(tpl_path),
                                      "draft_meta_info.json")))
    m = copy.deepcopy(tpl)
    m["draft_id"] = uid()
    m["draft_name"] = name
    m["draft_fold_path"] = folder
    m["draft_root_path"] = os.path.dirname(folder)
    m["draft_json_file"] = os.path.join(folder, "draft_info.json")
    m["draft_cover"] = os.path.join(folder, "draft_cover.jpg")
    m["tm_duration"] = duration_us
    m["draft_removable"] = True

    proto = None
    for bucket in m.get("draft_materials", []):
        if bucket.get("type") == 0 and bucket.get("value"):
            proto = bucket["value"][0]
            break
    items = []
    if proto:
        for s in doc["shots"]:
            p = staged.get(s["i"])
            if not p:
                continue
            it = copy.deepcopy(proto)
            # extra_info is what the media bin DISPLAYS. Left at the
            # prototype's value every clip is labelled IMG_9247.MOV and the bin
            # cannot be used to find a shot — which is most of what it is for.
            it.update({"id": uid(), "file_Path": p, "width": 1080, "height": 1920,
                       "duration": 10800000000, "metetype": "photo", "type": 0,
                       "md5": "", "extra_info": os.path.basename(p)})
            items.append(it)
        for n in sorted(voices):
            v = voices[n]
            it = copy.deepcopy(proto)
            it.update({"id": uid(), "file_Path": v, "metetype": "music",
                       "type": 0, "md5": "", "extra_info": os.path.basename(v)})
            items.append(it)
    for bucket in m.get("draft_materials", []):
        bucket["value"] = items if bucket.get("type") == 0 else []
    return m


def _register(projects, folder, name, draft_id, duration_us):
    """A draft that is not in root_meta_info.json is on disk and invisible."""
    root_path = os.path.join(projects, "root_meta_info.json")
    root = json.load(open(root_path))
    store = root.get("all_draft_store", [])
    proto = copy.deepcopy(store[0]) if store else {}
    store = [e for e in store if e.get("draft_name") != name]

    entry = proto
    entry.update({
        "draft_id": draft_id,
        "draft_name": name,
        "draft_fold_path": folder,
        "draft_root_path": os.path.dirname(folder),
        "draft_json_file": os.path.join(folder, "draft_info.json"),
        "draft_cover": os.path.join(folder, "draft_cover.jpg"),
        "draft_timeline_materials_size": 0,
        "tm_draft_create": 0,
        "tm_draft_modified": 0,
        "draft_is_invisible": False,
        "draft_removable": True,
    })
    # Times are left at 0 rather than stamped: CapCut fills them on first open,
    # and a made-up timestamp sorts the project into the wrong place in the list.
    store.insert(0, entry)
    root["all_draft_store"] = store
    ids = [e.get("draft_id") for e in store if e.get("draft_id")]
    root["draft_ids"] = ids
    shutil.copyfile(root_path, root_path + ".factbox-bak")
    with open(root_path, "w") as fh:
        json.dump(root, fh)
