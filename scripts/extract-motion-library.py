#!/usr/bin/env python3
"""
Extract, normalize, deduplicate, and curate portable F2A motion clips from local
After Effects (.aep) template packs into motion-library/builtin.json.

Usage:
  python scripts/extract-motion-library.py --source "<template_dir>" --out motion-library/builtin.json

Output contains ONLY pure mathematical keyframes, easing curves, and generic Chinese/English
labels — never local paths, usernames, or source filenames.
"""

import argparse
import glob
import hashlib
import json
import math
import os
import sys
import uuid
from collections import defaultdict

import py_aep as aep

INTERP_MAP = {6612: "linear", 6613: "bezier", 6614: "hold"}

TRACK_META = {
    "position": ([["ADBE Transform Group", 1], ["ADBE Position", 1]], "ThreeD_SPATIAL"),
    "scale": ([["ADBE Transform Group", 1], ["ADBE Scale", 1]], "ThreeD"),
    "rotation": ([["ADBE Transform Group", 1], ["ADBE Rotate Z", 1]], "OneD"),
    "opacity": ([["ADBE Transform Group", 1], ["ADBE Opacity", 1]], "OneD"),
}

NAMESPACE_F2A_MOTION = uuid.UUID("7f3b9a20-8e4c-4c72-9d4e-61a8b5f2a001")


def clean_num(v, digits=4):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        if not math.isfinite(v):
            return 0
        r = round(float(v), digits)
        if abs(r) < 1e-6:
            return 0
        if abs(r - round(r)) < 1e-6:
            return int(round(r))
        return r
    if isinstance(v, (list, tuple)):
        return [clean_num(x, digits) for x in v]
    return v


def clamp_influence(inf):
    if not math.isfinite(inf):
        return 33.33
    return clean_num(max(0.1, min(100.0, float(inf))), 2)


def pack_eases(ease_list, speed_scale=1.0, max_dims=None):
    if not ease_list:
        return None
    items = list(ease_list)
    if max_dims is not None:
        items = items[:max_dims]
    out = []
    for e in items:
        sp = float(getattr(e, "speed", 0.0) or 0.0) * speed_scale
        if not math.isfinite(sp):
            sp = 0.0
        inf = float(getattr(e, "influence", 33.33) or 33.33)
        out.append({"speed": clean_num(sp, 3), "influence": clamp_influence(inf)})
    return out if out else None


def extract_raw_kfs(prop, fps):
    kfs = getattr(prop, "keyframes", None)
    if not kfs or len(kfs) < 2:
        return None
    out = []
    for kf in kfs:
        ft = getattr(kf, "frame_time", None)
        if ft is None:
            continue
        t = float(ft) / float(fps or 30.0)
        val = kf.value
        if isinstance(val, (list, tuple)):
            val = [float(x) for x in val]
        else:
            val = float(val)
        in_i = INTERP_MAP.get(int(getattr(kf, "in_interpolation_type", 6612)), "linear")
        out_i = INTERP_MAP.get(int(getattr(kf, "out_interpolation_type", 6612)), "linear")
        in_e = getattr(kf, "in_temporal_ease", None)
        out_e = getattr(kf, "out_temporal_ease", None)
        out.append({
            "t": t,
            "v": val,
            "in_i": in_i,
            "out_i": out_i,
            "in_e": in_e,
            "out_e": out_e,
        })
    # Ensure strictly increasing times
    cleaned = []
    for item in out:
        if cleaned and item["t"] <= cleaned[-1]["t"] + 1e-4:
            continue
        cleaned.append(item)
    return cleaned if len(cleaned) >= 2 else None


def val_dist(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b)
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a[:2], b[:2])))


def split_active_segments(kfs, min_hold=0.32):
    """Split a keyframe sequence around long static holds (e.g. In -> Hold -> Out)."""
    segs = []
    cur = [kfs[0]]
    for i in range(1, len(kfs)):
        prev, nxt = kfs[i - 1], kfs[i]
        dt = nxt["t"] - prev["t"]
        dv = val_dist(prev["v"], nxt["v"])
        if dv < 0.25 and dt >= min_hold:
            if len(cur) >= 2:
                segs.append(cur)
            cur = [nxt]
        else:
            cur.append(nxt)
    if len(cur) >= 2:
        segs.append(cur)
    return segs


def trim_static_ends(seg):
    while len(seg) >= 3 and val_dist(seg[0]["v"], seg[1]["v"]) < 0.15:
        seg = seg[1:]
    while len(seg) >= 3 and val_dist(seg[-2]["v"], seg[-1]["v"]) < 0.15:
        seg = seg[:-1]
    return seg


def avg_influence(seg):
    vals = []
    for k in seg:
        for e_list in (k["in_e"], k["out_e"]):
            if e_list:
                for e in e_list:
                    inf = float(getattr(e, "influence", 33.33) or 33.33)
                    if 0.1 <= inf <= 100.0:
                        vals.append(inf)
    return sum(vals) / len(vals) if vals else 33.33


def max_influence(seg):
    vals = []
    for k in seg:
        for e_list in (k["in_e"], k["out_e"]):
            if e_list:
                for e in e_list:
                    inf = float(getattr(e, "influence", 33.33) or 33.33)
                    if 0.1 <= inf <= 100.0:
                        vals.append(inf)
    return max(vals) if vals else 33.33


def build_track(prop_name, seg, t_origin, comp_width, anchor="end", max_travel=340.0):
    """Convert raw segment keyframes into normalized F2A track dict."""
    path_spec, val_type = TRACK_META[prop_name]
    ref_v = seg[-1]["v"] if anchor == "end" else seg[0]["v"]
    speed_scale = 1.0

    if prop_name == "position":
        base_scale = 1920.0 / float(comp_width or 1920.0)
        deltas = []
        max_d = 0.0
        for k in seg:
            dx = (k["v"][0] - ref_v[0]) * base_scale
            dy = (k["v"][1] - ref_v[1]) * base_scale
            d = math.hypot(dx, dy)
            max_d = max(max_d, d)
            deltas.append((dx, dy))
        if max_d < 12.0:
            return None
        if max_d > max_travel:
            clamp_ratio = max_travel / max_d
            deltas = [(dx * clamp_ratio, dy * clamp_ratio) for dx, dy in deltas]
            speed_scale = base_scale * clamp_ratio
        else:
            speed_scale = base_scale
        keys = []
        for idx, k in enumerate(seg):
            dx, dy = deltas[idx]
            item = {
                "time": clean_num(k["t"] - t_origin, 4),
                "value": [clean_num(dx, 2), clean_num(dy, 2), 0],
                "inInterp": k["in_i"],
                "outInterp": k["out_i"],
            }
            if k["in_i"] == "bezier" or k["out_i"] == "bezier":
                ie = pack_eases(k["in_e"], speed_scale, max_dims=1)
                oe = pack_eases(k["out_e"], speed_scale, max_dims=1)
                if ie and oe:
                    item["inEase"] = ie
                    item["outEase"] = oe
            keys.append(item)
        return {"path": path_spec, "type": val_type, "keys": keys}

    if prop_name == "scale":
        # Normalize resting scale (anchor key) to [100, 100, 100] when anchor > 15%
        ax = ref_v[0] if abs(ref_v[0]) > 15.0 else 100.0
        ay = ref_v[1] if abs(ref_v[1]) > 15.0 else 100.0
        sx = 100.0 / ax
        sy = 100.0 / ay
        norm_vals = []
        for k in seg:
            vx = max(0.0, min(260.0, k["v"][0] * sx))
            vy = max(0.0, min(260.0, k["v"][1] * sy))
            norm_vals.append([clean_num(vx, 2), clean_num(vy, 2), 100])
        span = max(
            max(abs(v[0] - norm_vals[0][0]) for v in norm_vals),
            max(abs(v[1] - norm_vals[0][1]) for v in norm_vals),
        )
        if span < 8.0:
            return None
        speed_scale = (abs(sx) + abs(sy)) * 0.5
        keys = []
        for idx, k in enumerate(seg):
            item = {
                "time": clean_num(k["t"] - t_origin, 4),
                "value": norm_vals[idx],
                "inInterp": k["in_i"],
                "outInterp": k["out_i"],
            }
            if k["in_i"] == "bezier" or k["out_i"] == "bezier":
                ie = pack_eases(k["in_e"], speed_scale, max_dims=3)
                oe = pack_eases(k["out_e"], speed_scale, max_dims=3)
                if ie and oe:
                    # Pad to 3 dims if needed
                    while len(ie) < 3:
                        ie.append(ie[-1])
                    while len(oe) < 3:
                        oe.append(oe[-1])
                    item["inEase"] = ie
                    item["outEase"] = oe
            keys.append(item)
        return {"path": path_spec, "type": val_type, "keys": keys}

    if prop_name == "rotation":
        ref_r = float(ref_v)
        norm_vals = [clean_num(float(k["v"]) - ref_r, 2) for k in seg]
        span = max(norm_vals) - min(norm_vals)
        if span < 5.0 or span > 720.0:
            return None
        keys = []
        for idx, k in enumerate(seg):
            item = {
                "time": clean_num(k["t"] - t_origin, 4),
                "value": norm_vals[idx],
                "inInterp": k["in_i"],
                "outInterp": k["out_i"],
            }
            if k["in_i"] == "bezier" or k["out_i"] == "bezier":
                ie = pack_eases(k["in_e"], 1.0, max_dims=1)
                oe = pack_eases(k["out_e"], 1.0, max_dims=1)
                if ie and oe:
                    item["inEase"] = ie
                    item["outEase"] = oe
            keys.append(item)
        return {"path": path_spec, "type": val_type, "keys": keys}

    if prop_name == "opacity":
        norm_vals = []
        for k in seg:
            v = max(0.0, min(100.0, float(k["v"])))
            if v <= 2.0:
                v = 0.0
            elif v >= 98.0:
                v = 100.0
            norm_vals.append(clean_num(v, 2))
        span = max(norm_vals) - min(norm_vals)
        if span < 15.0:
            return None
        keys = []
        for idx, k in enumerate(seg):
            item = {
                "time": clean_num(k["t"] - t_origin, 4),
                "value": norm_vals[idx],
                "inInterp": k["in_i"],
                "outInterp": k["out_i"],
            }
            if k["in_i"] == "bezier" or k["out_i"] == "bezier":
                ie = pack_eases(k["in_e"], 1.0, max_dims=1)
                oe = pack_eases(k["out_e"], 1.0, max_dims=1)
                if ie and oe:
                    item["inEase"] = ie
                    item["outEase"] = oe
            keys.append(item)
        return {"path": path_spec, "type": val_type, "keys": keys}

    return None


def make_artifact(slug, name, category, phase, default_anchor, description, tags, tracks, source_style="curated"):
    # Normalize keyframe times to start at 0
    min_t = min(tr["keys"][0]["time"] for tr in tracks)
    max_t = max(tr["keys"][-1]["time"] for tr in tracks)
    duration = clean_num(max(0.05, max_t - min_t), 4)
    norm_tracks = []
    for tr in tracks:
        nkeys = []
        prev_t = -1.0
        for k in tr["keys"]:
            t = clean_num(max(0.0, min(duration, k["time"] - min_t)), 4)
            if t <= prev_t:
                t = clean_num(min(duration, prev_t + 0.005), 4)
            if t <= prev_t:
                continue
            prev_t = t
            nk = dict(k)
            nk["time"] = t
            nkeys.append(nk)
        if len(nkeys) < 2:
            continue
        ntr = dict(tr)
        ntr["keys"] = nkeys
        norm_tracks.append(ntr)
    if not norm_tracks:
        return None
    # Recompute exact duration from last key
    duration = clean_num(max(tr["keys"][-1]["time"] for tr in norm_tracks), 4)
    clip = {
        "origin": 0,
        "duration": duration,
        "layers": [{"name": name, "tracks": norm_tracks}],
    }
    clip_json = json.dumps(clip, separators=(",", ":"), ensure_ascii=False)
    content_hash = hashlib.sha256(clip_json.encode("utf-8")).hexdigest()
    clip_id = str(uuid.uuid5(NAMESPACE_F2A_MOTION, slug))
    return {
        "schemaVersion": 1,
        "id": clip_id,
        "slug": slug,
        "name": name,
        "category": category,
        "phase": phase,
        "defaultAnchor": default_anchor,
        "description": description,
        "sourceStyle": source_style,
        "tags": tags,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "contentHash": content_hash,
        "clip": clip,
    }


def direction_of_position(tr, phase):
    """Return cardinal/diagonal direction of travel ('up','down','left','right','diag')."""
    k0 = tr["keys"][0]["value"]
    k1 = tr["keys"][-1]["value"]
    dx = k1[0] - k0[0]
    dy = k1[1] - k0[1]
    if abs(dx) < 8 and abs(dy) < 8:
        # Overshoot or return-to-origin: measure first peak
        peak = max(tr["keys"], key=lambda k: math.hypot(k["value"][0] - k0[0], k["value"][1] - k0[1]))
        dx = peak["value"][0] - k0[0]
        dy = peak["value"][1] - k0[1]
    if abs(dx) > 2.2 * abs(dy):
        return "right" if dx > 0 else "left"
    if abs(dy) > 2.2 * abs(dx):
        return "down" if dy > 0 else "up"
    return "diag"


def has_position_overshoot(tr):
    ks = tr["keys"]
    if len(ks) < 3:
        return False
    p0, p1, p2 = ks[0]["value"], ks[1]["value"], ks[2]["value"]
    dx1, dy1 = p1[0] - p0[0], p1[1] - p0[1]
    dx2, dy2 = p2[0] - p1[0], p2[1] - p1[1]
    return (dx1 * dx2 + dy1 * dy2) < -25.0


def has_scale_overshoot(tr):
    ks = tr["keys"]
    if len(ks) < 3:
        return False
    s0, s1, s2 = ks[0]["value"][0], ks[1]["value"][0], ks[2]["value"][0]
    return (s1 - s0) * (s2 - s1) < -16.0


def harvest_from_source(source_dir):
    """Harvest categorized candidates from all .aep files in source_dir."""
    aep_files = sorted(glob.glob(os.path.join(source_dir, "**", "*.aep"), recursive=True))
    aep_files = [
        p for p in aep_files
        if "Auto-Save" not in p and "copy 17" not in p and "CS6" not in p
    ]
    print(f"Scanning {len(aep_files)} AEP files...", flush=True)

    buckets = defaultdict(list)

    for fp in aep_files:
        folder_style = os.path.basename(os.path.dirname(fp))
        try:
            proj = aep.parse(fp).project
        except Exception:
            continue
        for comp in proj.compositions:
            fps = float(comp.frame_rate or 30.0)
            w = float(comp.width or 1920.0)
            for layer in comp.layers:
                tf = getattr(layer, "transform", None)
                if tf is None:
                    continue
                raw_props = {}
                for pname in ("position", "scale", "rotation", "opacity"):
                    prop = getattr(tf, pname, None)
                    if prop is None:
                        continue
                    kfs = extract_raw_kfs(prop, fps)
                    if kfs:
                        raw_props[pname] = kfs
                if not raw_props:
                    continue

                # 1) Single-track segments (split In / Out cleanly!)
                for pname, kfs in raw_props.items():
                    segs = split_active_segments(kfs)
                    for seg_idx, raw_seg in enumerate(segs):
                        seg = trim_static_ends(raw_seg)
                        dur = seg[-1]["t"] - seg[0]["t"]
                        if dur < 0.16 or dur > 2.4:
                            continue
                        is_exit = False
                        if pname == "opacity":
                            is_exit = seg[0]["v"] > 60 and seg[-1]["v"] < 30
                        elif pname == "scale":
                            is_exit = (seg[0]["v"][0] + seg[0]["v"][1]) > (seg[-1]["v"][0] + seg[-1]["v"][1]) + 35 and seg[-1]["v"][0] < 45
                        elif len(segs) >= 2 and seg_idx == len(segs) - 1:
                            is_exit = True
                        else:
                            # If outgoing influence is much larger than incoming influence, it's an accelerate-out exit!
                            out_inf0 = seg[0]["out_e"][0].influence if seg[0]["out_e"] else 33.3
                            in_inf1 = seg[-1]["in_e"][0].influence if seg[-1]["in_e"] else 33.3
                            if out_inf0 >= 65 and in_inf1 <= 35:
                                is_exit = True

                        anchor = "start" if is_exit else "end"
                        tr = build_track(pname, seg, seg[0]["t"], w, anchor=anchor)
                        if not tr:
                            continue
                        inf_max = max_influence(seg)
                        inf_avg = avg_influence(seg)
                        score = inf_max + (15 if len(seg) >= 3 else 0) - abs(dur - 0.72) * 18

                        if pname == "position":
                            d = direction_of_position(tr, "out" if is_exit else "in")
                            net_travel = val_dist(tr["keys"][0]["value"], tr["keys"][-1]["value"])
                            if has_position_overshoot(tr) and not is_exit and net_travel >= 45:
                                buckets[f"pos_overshoot_{d}"].append((score, dur, inf_max, folder_style, [tr]))
                            elif is_exit and net_travel >= 80:
                                buckets[f"pos_out_{d}"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and net_travel >= 95:
                                bucket_tag = "whip" if inf_max >= 78 else ("smooth" if dur >= 0.85 else "snappy")
                                buckets[f"pos_in_{bucket_tag}_{d}"].append((score, dur, inf_max, folder_style, [tr]))

                        elif pname == "scale":
                            k0, k1 = tr["keys"][0]["value"], tr["keys"][-1]["value"]
                            peak_x = max(k["value"][0] for k in tr["keys"])
                            if has_scale_overshoot(tr) and not is_exit and k0[0] <= 55 and 95 <= k1[0] <= 105 and peak_x >= 106:
                                buckets["scale_overshoot_in"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and k0[0] <= 20 and k0[1] >= 85 and 95 <= k1[0] <= 105 and 95 <= k1[1] <= 105:
                                buckets["scale_stretch_x"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and k0[1] <= 20 and k0[0] >= 85 and 95 <= k1[0] <= 105 and 95 <= k1[1] <= 105:
                                buckets["scale_stretch_y"].append((score, dur, inf_max, folder_style, [tr]))
                            elif is_exit and k0[0] >= 90 and k1[0] <= 25:
                                buckets["scale_out"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and k0[0] > 125 and 95 <= k1[0] <= 105 and abs(k0[0] - k0[1]) < 15:
                                buckets["scale_zoom_settle"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and k0[0] < 35 and 95 <= k1[0] <= 105 and abs(k0[0] - k0[1]) < 15:
                                buckets["scale_pop_in"].append((score, dur, inf_max, folder_style, [tr]))
                            elif abs(k0[0] - 100) < 5 and abs(k1[0] - 100) < 5 and len(tr["keys"]) >= 3:
                                buckets["scale_pulse"].append((score, dur, inf_max, folder_style, [tr]))

                        elif pname == "rotation":
                            span = abs(tr["keys"][-1]["value"] - tr["keys"][0]["value"])
                            if len(tr["keys"]) >= 3 and span < 8:
                                buckets["rot_swing"].append((score, dur, inf_max, folder_style, [tr]))
                            elif is_exit and dur <= 1.3 and span >= 20:
                                buckets["rot_out"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and 160 <= span <= 210:
                                buckets["rot_flip_180"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and 70 <= span <= 115:
                                buckets["rot_turn_90"].append((score, dur, inf_max, folder_style, [tr]))
                            elif not is_exit and 10 <= span <= 45:
                                buckets["rot_tilt_in"].append((score, dur, inf_max, folder_style, [tr]))

                        elif pname == "opacity":
                            vs = [k["value"] for k in tr["keys"]]
                            if len(vs) >= 4 and dur <= 1.6 and vs[-1] >= 90:
                                buckets["opacity_glitch_in"].append((score + len(vs) * 5, dur, inf_max, folder_style, [tr]))
                            elif len(vs) >= 3 and vs[0] <= 10 and vs[-1] <= 10 and max(vs) >= 70:
                                buckets["opacity_flash"].append((score, dur, inf_max, folder_style, [tr]))
                            elif len(vs) >= 3 and vs[0] >= 80 and vs[-1] >= 80 and min(vs) <= 45:
                                buckets["opacity_breathe"].append((score, dur, inf_max, folder_style, [tr]))
                            elif is_exit:
                                buckets["opacity_out"].append((score, dur, inf_max, folder_style, [tr]))
                            elif vs[0] <= 10 and vs[-1] >= 90:
                                buckets["opacity_in"].append((score, dur, inf_max, folder_style, [tr]))

                # 2) Multi-track combo segments (take overlapping first entrance window!)
                if len(raw_props) >= 2:
                    first_segs = {}
                    for pname, kfs in raw_props.items():
                        segs = split_active_segments(kfs)
                        if not segs:
                            continue
                        seg = trim_static_ends(segs[0])
                        dur = seg[-1]["t"] - seg[0]["t"]
                        if 0.16 <= dur <= 2.2:
                            first_segs[pname] = seg
                    if len(first_segs) >= 2:
                        # Check temporal overlap
                        t0 = min(s[0]["t"] for s in first_segs.values())
                        t1 = max(s[-1]["t"] for s in first_segs.values())
                        if t1 - t0 <= 2.2:
                            # Determine if combo is an exit
                            is_exit = False
                            if "opacity" in first_segs and first_segs["opacity"][0]["v"] > 60 and first_segs["opacity"][-1]["v"] < 30:
                                is_exit = True
                            anchor = "start" if is_exit else "end"
                            combo_tracks = []
                            inf_scores = []
                            for pname in sorted(first_segs.keys()):
                                tr = build_track(pname, first_segs[pname], t0, w, anchor=anchor)
                                if tr:
                                    combo_tracks.append(tr)
                                    inf_scores.append(max_influence(first_segs[pname]))
                            if len(combo_tracks) >= 2:
                                combo_key = "+".join(sorted(
                                    k for k, v in first_segs.items()
                                    if any(tr["path"] == TRACK_META[k][0] for tr in combo_tracks)
                                ))
                                sc = (sum(inf_scores) / len(inf_scores)) + len(combo_tracks) * 12 - abs((t1 - t0) - 0.85) * 15
                                suffix = "out" if is_exit else "in"
                                buckets[f"combo_{combo_key}_{suffix}"].append((sc, t1 - t0, max(inf_scores), folder_style, combo_tracks))

    print(f"Discovered {len(buckets)} motion buckets:", {k: len(v) for k, v in sorted(buckets.items())}, flush=True)
    return buckets


def pick_best(buckets, key, index=0):
    items = buckets.get(key)
    if not items:
        return None
    ranked = sorted(items, key=lambda x: x[0], reverse=True)
    # Deduplicate roughly by (duration_bucket, key_count)
    picked = []
    seen = set()
    for it in ranked:
        sig = (round(it[1], 1), tuple(len(tr["keys"]) for tr in it[4]), it[3])
        if sig in seen:
            continue
        seen.add(sig)
        picked.append(it)
    if index < len(picked):
        return picked[index]
    return ranked[min(index, len(ranked) - 1)]


def mirror_position_track(tr, flip_x=False, flip_y=False, swap_xy=False):
    ntr = json.loads(json.dumps(tr))
    for k in ntr["keys"]:
        x, y, z = k["value"]
        if swap_xy:
            x, y = y, x
        if flip_x:
            x = -x
        if flip_y:
            y = -y
        k["value"] = [clean_num(x, 2), clean_num(y, 2), clean_num(z, 2)]
    return ntr


def scale_position_track(tr, factor):
    ntr = json.loads(json.dumps(tr))
    for k in ntr["keys"]:
        k["value"] = [clean_num(k["value"][0] * factor, 2), clean_num(k["value"][1] * factor, 2), 0]
        for ek in ("inEase", "outEase"):
            if ek in k:
                for e in k[ek]:
                    e["speed"] = clean_num(e["speed"] * factor, 3)
    return ntr


def add_opacity_fade(tracks, phase="in"):
    dur = max(tr["keys"][-1]["time"] for tr in tracks)
    fade_t = clean_num(min(dur, max(0.18, dur * 0.65)), 4)
    if phase == "in":
        op = {
            "path": TRACK_META["opacity"][0],
            "type": "OneD",
            "keys": [
                {"time": 0, "value": 0, "inInterp": "bezier", "outInterp": "bezier",
                 "inEase": [{"speed": 0, "influence": 33.33}], "outEase": [{"speed": 0, "influence": 33.33}]},
                {"time": fade_t, "value": 100, "inInterp": "bezier", "outInterp": "bezier",
                 "inEase": [{"speed": 0, "influence": 75}], "outEase": [{"speed": 0, "influence": 33.33}]},
            ],
        }
    else:
        t0 = clean_num(max(0, dur - fade_t), 4)
        op = {
            "path": TRACK_META["opacity"][0],
            "type": "OneD",
            "keys": [
                {"time": t0, "value": 100, "inInterp": "bezier", "outInterp": "bezier",
                 "inEase": [{"speed": 0, "influence": 33.33}], "outEase": [{"speed": 0, "influence": 65}]},
                {"time": dur, "value": 0, "inInterp": "bezier", "outInterp": "bezier",
                 "inEase": [{"speed": 0, "influence": 33.33}], "outEase": [{"speed": 0, "influence": 33.33}]},
            ],
        }
    return tracks + [op]


def curate_library(buckets):
    """Curate a balanced, designer-grade library of ~44 reusable clips from extracted buckets."""
    specs = [
        # --- 滑入入场 (Slide In) ---
        ("pos_in_whip_up", 0, "curated-whip-slide-up", "急停上滑入场", "入场", "in", "end",
         "高速切入后强缓动刹停，适合大标题与主视觉卡片入场。", ["入场", "滑入", "急停", "上浮", "位移"]),
        ("pos_in_whip_left", 0, "curated-whip-slide-left", "急停左滑入场", "入场", "in", "end",
         "从右侧高速甩入并强减速落位，节奏利落干脆。", ["入场", "滑入", "急停", "横向", "位移"]),
        ("pos_in_whip_right", 0, "curated-whip-slide-right", "急停右滑入场", "入场", "in", "end",
         "从左侧高速甩入并强减速落位，适合导航与侧边模块。", ["入场", "滑入", "急停", "横向", "位移"]),
        ("pos_in_whip_down", 0, "curated-whip-slide-down", "急停下滑入场", "入场", "in", "end",
         "从上方迅捷滑落并柔停，适合顶部横幅与徽章。", ["入场", "滑入", "急停", "下落", "位移"]),
        ("pos_in_smooth_up", 0, "curated-smooth-float-up", "柔缓上浮入场", "入场", "in", "end",
         "柔和舒适的纵向上浮曲线，适合正文、副标题与优雅 UI。", ["入场", "上浮", "柔和", "位移"]),
        ("pos_in_smooth_right", 0, "curated-smooth-glide-right", "柔缓横移入场", "入场", "in", "end",
         "平顺的横向推进缓动，适合列表项与图文混排。", ["入场", "横移", "柔和", "位移"]),
        ("pos_in_snappy_diag", 0, "curated-diag-swoop-in", "斜向切入入场", "入场", "in", "end",
         "沿对角线轻快切入落位，增加动感层次。", ["入场", "斜向", "切入", "位移"]),

        # --- 过冲与弹跳 (Overshoot & Bounce) ---
        ("pos_overshoot_up", 0, "curated-overshoot-up", "过冲回弹上浮", "弹跳", "in", "end",
         "越过目标点后轻弹回落，具备鲜活的手调弹性手感。", ["入场", "弹跳", "过冲", "上浮", "位移"]),
        ("pos_overshoot_left", 0, "curated-overshoot-left", "过冲回弹左滑", "弹跳", "in", "end",
         "从右侧冲过终点再微幅回弹，适合焦点卡片与弹窗。", ["入场", "弹跳", "过冲", "横向", "位移"]),
        ("pos_overshoot_right", 0, "curated-overshoot-right", "过冲回弹右滑", "弹跳", "in", "end",
         "从左侧冲过终点再微幅回弹，适合气泡与按钮提示。", ["入场", "弹跳", "过冲", "横向", "位移"]),
        ("pos_overshoot_down", 0, "curated-overshoot-down", "过冲回弹下落", "弹跳", "in", "end",
         "自上坠落微超目标位后回弹稳定，适合徽章与掉落标签。", ["入场", "弹跳", "过冲", "下落", "位移"]),
        ("scale_overshoot_in", 0, "curated-scale-overshoot", "弹性过冲弹出", "弹跳", "in", "end",
         "从小放大至超调后回弹至 100%，极具手调动效质感。", ["入场", "弹跳", "过冲", "缩放", "弹出"]),
        ("scale_overshoot_in", 1, "curated-scale-bounce-pop", "清脆二次弹入", "弹跳", "in", "end",
         "高张力弹性缩放，适合主 CTA 按钮、角标与核心图标。", ["入场", "弹跳", "缩放", "图标"]),

        # --- 缩放与展开 (Scale & Unfold) ---
        ("scale_pop_in", 0, "curated-scale-snappy-in", "急停缩放弹出", "缩放", "in", "end",
         "零尺寸爆发放大并迅速收敛，干净利落不拖泥带水。", ["入场", "缩放", "弹出", "急停"]),
        ("scale_zoom_settle", 0, "curated-scale-zoom-settle", "大景推近落位", "缩放", "in", "end",
         "由大尺寸向内收缩落位，营造电影感冲击开场。", ["入场", "缩放", "冲击", "大标题"]),
        ("scale_stretch_x", 0, "curated-scale-unfold-x", "横向拉开展示", "缩放", "in", "end",
         "保持高度不变，沿水平方向展开，适合分割线与色块底条。", ["入场", "缩放", "展开", "横向", "线条"]),
        ("scale_stretch_y", 0, "curated-scale-unfold-y", "纵向拉开展开", "缩放", "in", "end",
         "保持宽度不变，沿垂直方向展开，适合卡片容器与柱状图。", ["入场", "缩放", "展开", "纵向", "卡片"]),
        ("scale_pulse", 0, "curated-scale-pulse", "强调呼吸脉冲", "强调", "emphasis", "end",
         "原位放大再回落至 100%，用于引导关注与点击反馈。", ["强调", "循环", "缩放", "脉冲", "呼吸"]),

        # --- 旋转与翻转 (Rotation) ---
        ("rot_tilt_in", 0, "curated-rot-tilt-in", "微倾摆正入场", "旋转", "in", "end",
         "小角度倾斜入场后优雅摆正，适合徽章、卡片与装饰贴纸。", ["入场", "旋转", "摆正", "轻盈"]),
        ("rot_turn_90", 0, "curated-rot-turn-90", "90° 急停旋入", "旋转", "in", "end",
         "高影响度 90° 旋转切入刹停，适合图标与几何图形。", ["入场", "旋转", "急停", "90度"]),
        ("rot_flip_180", 0, "curated-rot-flip-180", "180° 动感翻转", "旋转", "in", "end",
         "大幅度 180° 高缓动翻转，视觉张力强。", ["入场", "旋转", "翻转", "180度"]),
        ("rot_swing", 0, "curated-rot-swing-emphasis", "轻盈摇摆强调", "强调", "emphasis", "end",
         "左右轻摆回归原位，适合角标提醒与俏皮图标。", ["强调", "旋转", "摇摆", "图标"]),

        # --- 透明与闪烁 (Opacity & Glitch) ---
        ("opacity_in", 0, "curated-opacity-silky-in", "丝滑渐显", "入场", "in", "end",
         "精细缓动透明度淡入，百搭背景与文字元素。", ["入场", "淡入", "透明度", "柔和"]),
        ("opacity_glitch_in", 0, "curated-opacity-glitch-in", "电子闪烁显现", "强调", "in", "end",
         "快节奏明暗闪烁后稳定点亮，适合科技感/赛博风格 UI。", ["入场", "闪烁", "故障", "科技", "透明度"]),
        ("opacity_breathe", 0, "curated-opacity-breathe", "柔和明暗呼吸", "强调", "emphasis", "end",
         "亮度轻柔暗下再恢复，适合光晕、指示灯与待机提示。", ["强调", "呼吸", "循环", "透明度"]),
        ("opacity_flash", 0, "curated-opacity-flash-pulse", "瞬闪高亮脉冲", "强调", "emphasis", "end",
         "快速点亮后柔缓熄灭，适合高光扫过与特效叠层。", ["强调", "闪光", "特效", "透明度"]),

        # --- 复合编排 (Combo Choreography) ---
        ("combo_opacity+position_in", 0, "curated-combo-fade-slide", "渐显滑入组合", "组合", "in", "end",
         "位移滑入同步叠加渐显淡入，最常用的 UI 卡片标准入场。", ["组合", "入场", "淡入", "滑入", "UI"]),
        ("combo_opacity+scale_in", 0, "curated-combo-fade-pop", "渐显弹出组合", "组合", "in", "end",
         "缩放弹出叠加丝滑渐显，适合弹窗、徽章与头像入场。", ["组合", "入场", "淡入", "缩放", "弹窗"]),
        ("combo_position+scale_in", 0, "curated-combo-slide-scale", "滑入推缩组合", "组合", "in", "end",
         "位移与缩放联动入场，带来富有空间景深的画面张力。", ["组合", "入场", "滑入", "缩放", "景深"]),
        ("combo_position+rotation_in", 0, "curated-combo-slide-spin", "旋滑切入组合", "组合", "in", "end",
         "横向切入同时伴随旋转摆正，动感活泼。", ["组合", "入场", "滑入", "旋转", "动感"]),
        ("combo_rotation+scale_in", 0, "curated-combo-spin-pop", "旋扩绽放组合", "组合", "in", "end",
         "旋转与缩放同步爆发，适合徽章、装饰星芒与 Logo。", ["组合", "入场", "旋转", "缩放", "Logo"]),
        ("combo_position+rotation+scale_in", 0, "curated-combo-kinetic-trio", "动感三联飞入", "组合", "in", "end",
         "位移、旋转、缩放三重联动，呈现高能量动态海报效果。", ["组合", "入场", "位移", "旋转", "缩放", "动感"]),

        # --- 退场出场 (Exits) ---
        ("pos_out_up", 0, "curated-exit-whip-up", "加速上滑退场", "出场", "out", "start",
         "由静止强加速向上甩出画面，干脆利落收尾。", ["出场", "退场", "滑出", "向上"]),
        ("pos_out_down", 0, "curated-exit-whip-down", "加速下滑退场", "出场", "out", "start",
         "强加速向下退出视野，适合弹窗与底部浮层收起。", ["出场", "退场", "滑出", "向下"]),
        ("pos_out_left", 0, "curated-exit-whip-left", "加速左滑退场", "出场", "out", "start",
         "向左加速甩出画面，适合轮播切换与卡片离场。", ["出场", "退场", "滑出", "向左"]),
        ("pos_out_right", 0, "curated-exit-whip-right", "加速右滑退场", "出场", "out", "start",
         "向右加速甩出画面，适合侧边栏与通知收起。", ["出场", "退场", "滑出", "向右"]),
        ("scale_out", 0, "curated-exit-scale-vanish", "收缩消失退场", "出场", "out", "start",
         "加速收缩至零尺寸消失，利落收尾不占画面。", ["出场", "退场", "缩放", "消失"]),
        ("rot_out", 0, "curated-exit-spin-out", "旋转离场退场", "出场", "out", "start",
         "伴随高缓动旋转退出，适合装饰与动感标语。", ["出场", "退场", "旋转"]),
        ("opacity_out", 0, "curated-exit-fade-out", "丝滑淡出退场", "出场", "out", "start",
         "平滑渐隐消失，适合任何元素的柔和收尾。", ["出场", "退场", "淡出", "透明度"]),
    ]

    clips = []
    used_slugs = set()

    for bucket_key, idx, slug, name, category, phase, anchor, desc, tags in specs:
        picked = pick_best(buckets, bucket_key, idx)
        if picked is None:
            continue
        _, _, _, style, tracks = picked
        art = make_artifact(slug, name, category, phase, anchor, desc, tags, tracks, source_style=style)
        if art:
            clips.append(art)
            used_slugs.add(slug)

    # Synthesize complementary UI-favorite Fade+Slide variants using real harvested curve shapes
    # so designers always have silky short-travel UI Fade+Float Up/Down/Left/Right ready at 1 click!
    base_up = pick_best(buckets, "pos_in_whip_up", 0) or pick_best(buckets, "pos_in_smooth_up", 0)
    if base_up:
        base_travel = max(1.0, val_dist(base_up[4][0]["keys"][0]["value"], base_up[4][0]["keys"][-1]["value"]))
        short_up = scale_position_track(base_up[4][0], 72.0 / base_travel)
        ui_variants = [
            ("curated-ui-fade-up", "UI 轻盈上浮淡入", "组合", "in", "end",
             "短距 72px 轻盈上浮配合渐显，网页与移动端 UI 黄金入场。", ["UI", "组合", "入场", "上浮", "淡入"],
             add_opacity_fade([short_up], "in")),
            ("curated-ui-fade-down", "UI 轻盈下沉淡入", "组合", "in", "end",
             "短距 72px 轻柔下沉配合渐显，适合下拉菜单与顶部提示条。", ["UI", "组合", "入场", "下落", "淡入"],
             add_opacity_fade([mirror_position_track(short_up, flip_y=True)], "in")),
            ("curated-ui-fade-left", "UI 轻盈左移淡入", "组合", "in", "end",
             "右侧短距 72px 轻滑配合渐显，适合列表与步进卡片。", ["UI", "组合", "入场", "横向", "淡入"],
             add_opacity_fade([mirror_position_track(short_up, swap_xy=True)], "in")),
            ("curated-ui-fade-right", "UI 轻盈右移淡入", "组合", "in", "end",
             "左侧短距 72px 轻滑配合渐显，适合侧边导航与标签组。", ["UI", "组合", "入场", "横向", "淡入"],
             add_opacity_fade([mirror_position_track(short_up, swap_xy=True, flip_x=True)], "in")),
        ]
        for slug, name, cat, ph, anc, desc, tags, trs in ui_variants:
            if slug not in used_slugs:
                art = make_artifact(slug, name, cat, ph, anc, desc, tags, trs, source_style="UI")
                if art:
                    clips.append(art)
                    used_slugs.add(slug)

    base_out = pick_best(buckets, "pos_out_up", 0)
    if base_out and "curated-ui-fade-out-up" not in used_slugs:
        out_travel = max(1.0, val_dist(base_out[4][0]["keys"][0]["value"], base_out[4][0]["keys"][-1]["value"]))
        short_out = scale_position_track(base_out[4][0], 72.0 / out_travel)
        art = make_artifact(
            "curated-ui-fade-out-up", "UI 轻盈上滑淡出", "出场", "out", "start",
            "短距 72px 轻滑配合同步渐隐，干脆柔和的 UI 离场。", ["UI", "出场", "退场", "上浮", "淡出"],
            add_opacity_fade([short_out], "out"), source_style="UI",
        )
        if art:
            clips.append(art)

    return clips


def procedural_presets():
    """F2A's built-in AE Motion procedural presets (editable keys, text animators, transitions)."""
    return [
        # Animate (layer moves)
        {"id": "preset-fade-in", "kind": "procedural", "command": "animate", "name": "参数化淡入", "category": "入场", "phase": "in",
         "description": "可调时长与缓动曲线的纯透明度入场。", "tags": ["参数化", "入场", "淡入", "透明度"],
         "defaults": {"move": "fade", "phase": "in", "duration": 0.45, "style": "smooth"},
         "supports": {"duration": True, "style": True, "stagger": True}},
        {"id": "preset-pop-in", "kind": "procedural", "command": "animate", "name": "弹簧弹出", "category": "弹跳", "phase": "in",
         "description": "物理弹簧过冲缩放弹出，支持弹性/回弹/利落曲线。", "tags": ["参数化", "入场", "弹出", "弹性", "缩放"],
         "defaults": {"move": "pop", "phase": "in", "duration": 0.5, "style": "spring"},
         "supports": {"duration": True, "style": True, "stagger": True}},
        {"id": "preset-grow-in", "kind": "procedural", "command": "animate", "name": "轻柔放大", "category": "缩放", "phase": "in",
         "description": "柔和放大并渐显入场，适合图片卡片与视觉面板。", "tags": ["参数化", "入场", "缩放", "柔和"],
         "defaults": {"move": "grow", "phase": "in", "duration": 0.55, "style": "smooth"},
         "supports": {"duration": True, "style": True, "stagger": True}},
        {"id": "preset-slide-in", "kind": "procedural", "command": "animate", "name": "方向滑入", "category": "入场", "phase": "in",
         "description": "支持上/下/左/右四向自定义距离滑入并自动渐显。", "tags": ["参数化", "入场", "滑入", "方向"],
         "defaults": {"move": "slide", "phase": "in", "duration": 0.5, "style": "snappy", "direction": "up", "distance": 96},
         "supports": {"duration": True, "style": True, "direction": True, "distance": True, "stagger": True}},
        {"id": "preset-drop-in", "kind": "procedural", "command": "animate", "name": "重力坠落弹入", "category": "弹跳", "phase": "in",
         "description": "带重力回弹手感的坠落入场，支持反弹曲线。", "tags": ["参数化", "入场", "坠落", "弹跳"],
         "defaults": {"move": "drop", "phase": "in", "duration": 0.6, "style": "bounce", "distance": 140},
         "supports": {"duration": True, "style": True, "distance": True, "stagger": True}},
        {"id": "preset-spin-in", "kind": "procedural", "command": "animate", "name": "旋转切入", "category": "旋转", "phase": "in",
         "description": "旋转并缩放切入，适合徽标、图标与视觉亮点。", "tags": ["参数化", "入场", "旋转"],
         "defaults": {"move": "spin", "phase": "in", "duration": 0.55, "style": "snappy"},
         "supports": {"duration": True, "style": True, "stagger": True}},
        {"id": "preset-push", "kind": "procedural", "command": "animate", "name": "微距推近", "category": "强调", "phase": "emphasis",
         "description": "轻微推近缩放（如 +8%），营造镜头呼吸感与海报纵深。", "tags": ["参数化", "强调", "推近", "镜头", "缩放"],
         "defaults": {"move": "push", "phase": "in", "duration": 1.6, "style": "smooth", "amount": 8},
         "supports": {"duration": True, "style": True, "stagger": True}},
        {"id": "preset-drift", "kind": "procedural", "command": "animate", "name": "缓慢漂移", "category": "强调", "phase": "emphasis",
         "description": "平滑单向微距漂移，适合背景装饰、云层与光斑。", "tags": ["参数化", "强调", "漂移", "背景", "位移"],
         "defaults": {"move": "drift", "phase": "in", "duration": 2.4, "style": "linear", "direction": "right", "distance": 60},
         "supports": {"duration": True, "direction": True, "distance": True, "stagger": True}},
        {"id": "preset-fade-out", "kind": "procedural", "command": "animate", "name": "参数化淡出", "category": "出场", "phase": "out",
         "description": "平顺淡出至 0% 透明度。", "tags": ["参数化", "出场", "淡出"],
         "defaults": {"move": "fade", "phase": "out", "duration": 0.4, "style": "smooth"},
         "supports": {"duration": True, "style": True, "stagger": True}},
        {"id": "preset-slide-out", "kind": "procedural", "command": "animate", "name": "方向滑出", "category": "出场", "phase": "out",
         "description": "沿指定方向滑出并同步渐隐离场。", "tags": ["参数化", "出场", "滑出", "方向"],
         "defaults": {"move": "slide", "phase": "out", "duration": 0.45, "style": "snappy", "direction": "down", "distance": 96},
         "supports": {"duration": True, "style": True, "direction": True, "distance": True, "stagger": True}},
        {"id": "preset-pop-out", "kind": "procedural", "command": "animate", "name": "缩放收起", "category": "出场", "phase": "out",
         "description": "快速收缩并淡出离场，适合弹窗与气泡关闭。", "tags": ["参数化", "出场", "缩放", "弹出"],
         "defaults": {"move": "pop", "phase": "out", "duration": 0.35, "style": "snappy"},
         "supports": {"duration": True, "style": True, "stagger": True}},

        # Text Reveal (native AE TextLayer animators)
        {"id": "preset-text-rise", "kind": "procedural", "command": "text_reveal", "name": "逐字上浮揭示", "category": "文字", "phase": "in",
         "description": "原生文字动画器：逐字从基线遮罩内上浮显现。", "tags": ["文字", "入场", "上浮", "遮罩", "逐字"],
         "defaults": {"style": "rise", "by": "chars", "phase": "in", "duration": 0.45, "stagger": 0.03, "ease": "snappy", "mask": True},
         "supports": {"duration": True, "style": True, "textBy": True, "textMask": True}},
        {"id": "preset-text-drop", "kind": "procedural", "command": "text_reveal", "name": "逐字坠落揭示", "category": "文字", "phase": "in",
         "description": "原生文字动画器：逐字自顶部遮罩线滑落显现。", "tags": ["文字", "入场", "下落", "遮罩", "逐字"],
         "defaults": {"style": "drop", "by": "chars", "phase": "in", "duration": 0.45, "stagger": 0.03, "ease": "snappy", "mask": True},
         "supports": {"duration": True, "style": True, "textBy": True, "textMask": True}},
        {"id": "preset-text-fade", "kind": "procedural", "command": "text_reveal", "name": "逐字柔光渐显", "category": "文字", "phase": "in",
         "description": "原生文字动画器：逐字平滑淡入，适合副标题与正文。", "tags": ["文字", "入场", "淡入", "逐字"],
         "defaults": {"style": "fade", "by": "chars", "phase": "in", "duration": 0.4, "stagger": 0.03, "ease": "smooth"},
         "supports": {"duration": True, "style": True, "textBy": True}},
        {"id": "preset-text-pop", "kind": "procedural", "command": "text_reveal", "name": "逐字弹性跳出", "category": "文字", "phase": "in",
         "description": "原生文字动画器：字符弹性缩放依次跃出。", "tags": ["文字", "入场", "弹跳", "逐字"],
         "defaults": {"style": "pop", "by": "chars", "phase": "in", "duration": 0.45, "stagger": 0.035, "ease": "spring"},
         "supports": {"duration": True, "style": True, "textBy": True}},
        {"id": "preset-text-blur", "kind": "procedural", "command": "text_reveal", "name": "逐字聚焦去模糊", "category": "文字", "phase": "in",
         "description": "原生文字动画器：由虚化模糊逐字聚焦清晰显现。", "tags": ["文字", "入场", "模糊", "电影感", "逐字"],
         "defaults": {"style": "blur", "by": "chars", "phase": "in", "duration": 0.5, "stagger": 0.03, "ease": "smooth"},
         "supports": {"duration": True, "style": True, "textBy": True}},
        {"id": "preset-text-typewriter", "kind": "procedural", "command": "text_reveal", "name": "打字机逐字敲入", "category": "文字", "phase": "in",
         "description": "原生文字动画器：干脆的打字机逐字显示节奏。", "tags": ["文字", "入场", "打字机", "逐字"],
         "defaults": {"style": "typewriter", "by": "chars", "phase": "in", "duration": 0, "stagger": 0.045, "ease": "linear"},
         "supports": {"textBy": True}},

        # Transitions
        {"id": "preset-trans-wipe", "kind": "procedural", "command": "transition", "name": "色块扫屏转场", "category": "转场", "phase": "transition",
         "description": "在当前播放头创建可编辑全屏扫光擦除转场层。", "tags": ["转场", "擦除", "扫屏"],
         "defaults": {"type": "wipe", "duration": 0.75, "direction": "right", "color": [0.08, 0.07, 0.12]},
         "supports": {"duration": True, "direction": True}},
        {"id": "preset-trans-bars", "kind": "procedural", "command": "transition", "name": "百叶条纹转场", "category": "转场", "phase": "transition",
         "description": "多层错峰条纹依次覆盖并揭开画面。", "tags": ["转场", "条纹", "百叶窗"],
         "defaults": {"type": "bars", "duration": 0.85, "direction": "right", "bars": 5, "color": [0.08, 0.07, 0.12]},
         "supports": {"duration": True, "direction": True}},
        {"id": "preset-trans-iris", "kind": "procedural", "command": "transition", "name": "光圈扩散转场", "category": "转场", "phase": "transition",
         "description": "中心圆环扩张遮屏再收缩揭开，适合焦点切换。", "tags": ["转场", "光圈", "圆形"],
         "defaults": {"type": "iris", "duration": 0.8, "color": [0.08, 0.07, 0.12]},
         "supports": {"duration": True}},
    ]


def main():
    parser = argparse.ArgumentParser(description="Build F2A built-in curated motion library JSON.")
    parser.add_argument("--source", required=True, help="Directory containing source .aep packs to harvest curves from.")
    parser.add_argument("--out", required=True, help="Output JSON path (e.g. motion-library/builtin.json).")
    args = parser.parse_args()

    buckets = harvest_from_source(args.source)
    clips = curate_library(buckets)
    presets = procedural_presets()

    payload = {
        "schemaVersion": 1,
        "generatedBy": "F2A Motion Library Extractor",
        "presets": presets,
        "clips": clips,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {len(presets)} procedural presets + {len(clips)} curated clips -> {args.out}")
    cats = defaultdict(int)
    for c in clips:
        cats[c["category"]] += 1
    for p in presets:
        cats[p["category"]] += 1
    print("Category distribution:", dict(sorted(cats.items())))


if __name__ == "__main__":
    main()
