"""Read-only offline AEP animation extractor using py_aep.

Useful when a reference .aep was saved by a newer After Effects version (e.g. AE 27)
that cannot be opened directly in the local AE instance (e.g. AE 26), or when inspecting
a reference project without disturbing the open AE session.

Run with F2A's bundled Python environment that has py_aep installed (e.g. .venv-aep).
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def cls_name(obj: object) -> str:
    return obj.__class__.__name__


def round_val(v):
    if isinstance(v, float):
        return round(v, 4)
    if isinstance(v, int):
        return v
    if isinstance(v, (list, tuple)):
        return [round_val(x) for x in v]
    return v


INTERP_NAMES = {
    6612: "LINEAR",
    6613: "BEZIER",
    6614: "HOLD",
}


def extract_keyframe(k) -> dict:
    in_t = getattr(k, "in_interpolation_type", None)
    out_t = getattr(k, "out_interpolation_type", None)
    return {
        "frame": getattr(k, "frame_time", None),
        "time": round_val(getattr(k, "time", None)),
        "value": round_val(getattr(k, "value", None)),
        "inType": INTERP_NAMES.get(in_t, in_t),
        "outType": INTERP_NAMES.get(out_t, out_t),
        "inEase": [
            {"speed": round_val(e.speed), "influence": round_val(e.influence)}
            for e in (getattr(k, "in_temporal_ease", None) or [])
        ],
        "outEase": [
            {"speed": round_val(e.speed), "influence": round_val(e.influence)}
            for e in (getattr(k, "out_temporal_ease", None) or [])
        ],
    }


def walk_animated_props(prop, path: str, out: list, include_markers: bool, depth: int = 0) -> None:
    if depth > 8:
        return
    kids = getattr(prop, "properties", None)
    if isinstance(kids, list) and kids:
        for child in kids:
            walk_animated_props(child, f"{path}/{getattr(child, 'name', '')}", out, include_markers, depth + 1)
        return
    match = getattr(prop, "match_name", None)
    if not include_markers and match == "ADBE Marker":
        return
    kfs = getattr(prop, "keyframes", None) or []
    expr = getattr(prop, "expression", "") or ""
    if kfs or expr:
        out.append({
            "path": path,
            "matchName": match,
            "keyCount": len(kfs),
            "keys": [extract_keyframe(k) for k in kfs],
            "expression": expr,
        })


def dump_aep(aep_path: Path, only_animated: bool, include_markers: bool) -> dict:
    import py_aep  # imported lazily so CLI errors clearly if run outside py_aep env

    app = py_aep.parse(str(aep_path))
    project = app.project

    all_items = {}
    stack = list(project.items.values())
    while stack:
        item = stack.pop(0)
        all_items[item.id] = item
        subs = getattr(item, "items", None)
        if isinstance(subs, dict):
            stack.extend(list(subs.values()))

    comps = [it for it in all_items.values() if cls_name(it) == "CompItem"]
    result_comps = []

    for comp in comps:
        layers_out = []
        animated_count = 0
        for layer in comp.layers:
            anims: list = []
            try:
                walk_animated_props(layer, "", anims, include_markers)
            except Exception as exc:
                anims.append({"error": str(exc)})
            if anims:
                animated_count += 1
            if only_animated and not anims:
                continue

            src = getattr(layer, "source", None)
            par = getattr(layer, "parent", None)
            transform = getattr(layer, "transform", None)

            layers_out.append({
                "index": layer.index,
                "name": layer.name,
                "enabled": getattr(layer, "enabled", None),
                "inPoint": round_val(getattr(layer, "in_point", None)),
                "outPoint": round_val(getattr(layer, "out_point", None)),
                "startTime": round_val(getattr(layer, "start_time", None)),
                "source": {"type": cls_name(src), "id": src.id, "name": src.name} if src else None,
                "parent": {"index": par.index, "name": par.name} if par else None,
                "anchorPoint": round_val(getattr(transform.anchor_point, "value", None)) if transform and hasattr(transform, "anchor_point") else None,
                "position": round_val(getattr(transform.position, "value", None)) if transform and hasattr(transform, "position") else None,
                "scale": round_val(getattr(transform.scale, "value", None)) if transform and hasattr(transform, "scale") else None,
                "opacity": round_val(getattr(transform.opacity, "value", None)) if transform and hasattr(transform, "opacity") else None,
                "animations": anims,
            })

        if only_animated and animated_count == 0:
            continue

        result_comps.append({
            "id": comp.id,
            "name": comp.name,
            "width": comp.width,
            "height": comp.height,
            "frameRate": round_val(comp.frame_rate),
            "duration": round_val(comp.duration),
            "workAreaStart": round_val(comp.work_area_start),
            "workAreaDuration": round_val(comp.work_area_duration),
            "totalLayers": len(comp.layers),
            "animatedLayers": animated_count,
            "layers": layers_out,
        })

    return {
        "file": str(aep_path),
        "totalComps": len(comps),
        "comps": result_comps,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract compositions, layer timing, and keyframes from an .aep file offline.")
    parser.add_argument("aep", type=Path, help="Path to reference .aep file")
    parser.add_argument("--all", action="store_true", help="Include non-animated comps and layers")
    parser.add_argument("--include-markers", action="store_true", help="Include layer markers (e.g. Sprite tags)")
    parser.add_argument("-o", "--output", type=Path, default=None, help="Optional JSON output file path")
    args = parser.parse_args()

    data = dump_aep(args.aep, only_animated=not args.all, include_markers=args.include_markers)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
        print(f"Wrote {args.output} ({len(data['comps'])} comps)")
    else:
        print(text)


if __name__ == "__main__":
    main()
