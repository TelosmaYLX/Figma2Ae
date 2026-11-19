"""Deterministic pixel-by-pixel RGBA comparison gate for Figma layer tidying."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def compare(before_path: Path, after_path: Path, diff_path: Path | None) -> dict:
    before_img = Image.open(before_path).convert("RGBA")
    after_img = Image.open(after_path).convert("RGBA")

    if before_img.size != after_img.size:
        return {
            "passed": False,
            "reason": "dimension_mismatch",
            "before_size": list(before_img.size),
            "after_size": list(after_img.size),
            "max_abs_diff": None,
            "mean_abs_diff": None,
            "changed_pixels": None,
            "total_pixels": int(before_img.size[0] * before_img.size[1]),
            "changed_bbox": None,
        }

    b = np.asarray(before_img, dtype=np.int16)
    a = np.asarray(after_img, dtype=np.int16)
    diff = np.abs(a - b)
    per_pixel_max = diff.max(axis=2)
    changed_mask = per_pixel_max > 0
    changed_pixels = int(changed_mask.sum())
    total_pixels = int(per_pixel_max.size)
    max_abs_diff = int(diff.max()) if total_pixels else 0
    mean_abs_diff = float(diff.mean()) if total_pixels else 0.0

    bbox = None
    if changed_pixels > 0:
        ys, xs = np.where(changed_mask)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        if diff_path is not None:
            diff_path.parent.mkdir(parents=True, exist_ok=True)
            vis = (np.asarray(before_img, dtype=np.float32) * 0.35).astype(np.uint8)
            vis[changed_mask, 0] = 255
            vis[changed_mask, 1] = 0
            vis[changed_mask, 2] = 180
            vis[changed_mask, 3] = 255
            Image.fromarray(vis, mode="RGBA").save(diff_path)

    return {
        "passed": changed_pixels == 0,
        "reason": None if changed_pixels == 0 else "pixel_mismatch",
        "before_size": list(before_img.size),
        "after_size": list(after_img.size),
        "max_abs_diff": max_abs_diff,
        "mean_abs_diff": round(mean_abs_diff, 6),
        "changed_pixels": changed_pixels,
        "total_pixels": total_pixels,
        "changed_bbox": bbox,
        "diff_image": str(diff_path) if (changed_pixels > 0 and diff_path is not None) else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify pixel-identical before/after Figma PNG exports.")
    parser.add_argument("before", type=Path, help="Baseline PNG exported before tidying")
    parser.add_argument("after", type=Path, help="Result PNG exported after tidying")
    parser.add_argument("--diff", type=Path, default=None, help="Optional output PNG highlighting changed pixels")
    args = parser.parse_args()

    result = compare(args.before, args.after, args.diff)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["passed"] else 2)


if __name__ == "__main__":
    main()
