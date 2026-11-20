"""Deterministic RGBA comparison gate for F2A AEP static fidelity & resting-frame verification.

Supports two modes:
1. resting  : Compare final animation resting frame against pre-animation static AE baseline.
              Default tolerance allows minor floating-point rounding (max_diff <= 2, ratio >2 == 0).
2. static   : Compare pre-animation static AE export frame against Figma full-frame reference PNG
              (supports clipsContent:false overflow alignment via --ref-offset-x / --ref-offset-y).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def align_reference(ref_img: Image.Image, target_size: tuple[int, int], offset_x: int, offset_y: int, bg_rgb: tuple[int, int, int]) -> Image.Image:
    """Composite reference PNG onto a target_size opaque canvas at (offset_x, offset_y)."""
    canvas = Image.new("RGBA", target_size, (*bg_rgb, 255))
    canvas.paste(ref_img, (offset_x, offset_y), ref_img)
    return canvas


def compare_images(
    baseline_path: Path,
    candidate_path: Path,
    mode: str,
    diff_path: Path | None,
    ref_offset_x: int,
    ref_offset_y: int,
    bg_rgb: tuple[int, int, int],
    max_allowed_diff: int,
    max_mean_diff: float,
    max_over_threshold_ratio: float,
) -> dict:
    base_img = Image.open(baseline_path).convert("RGBA")
    cand_img = Image.open(candidate_path).convert("RGBA")

    if mode == "static" and (base_img.size != cand_img.size or ref_offset_x != 0 or ref_offset_y != 0):
        base_aligned = align_reference(base_img, cand_img.size, ref_offset_x, ref_offset_y, bg_rgb)
    else:
        if base_img.size != cand_img.size:
            return {
                "mode": mode,
                "passed": False,
                "reason": "dimension_mismatch",
                "baseline_size": list(base_img.size),
                "candidate_size": list(cand_img.size),
            }
        base_aligned = base_img

    channels = 3 if mode == "static" else 4
    b = np.asarray(base_aligned, dtype=np.int16)[:, :, :channels]
    c = np.asarray(cand_img, dtype=np.int16)[:, :, :channels]
    diff = np.abs(c - b)
    per_pixel_max = diff.max(axis=2)

    total_pixels = int(per_pixel_max.size)
    max_abs_diff = int(diff.max()) if total_pixels else 0
    mean_abs_diff = float(diff.mean()) if total_pixels else 0.0
    nonzero_pixels = int((per_pixel_max > 0).sum())
    over_thresh_mask = per_pixel_max > max_allowed_diff
    over_thresh_pixels = int(over_thresh_mask.sum())
    over_thresh_ratio = (over_thresh_pixels / total_pixels) if total_pixels else 0.0

    bbox = None
    if over_thresh_pixels > 0:
        ys, xs = np.where(over_thresh_mask)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]

    if diff_path is not None and nonzero_pixels > 0:
        diff_path.parent.mkdir(parents=True, exist_ok=True)
        vis = (np.asarray(cand_img, dtype=np.float32) * 0.35).astype(np.uint8)
        highlight = over_thresh_mask if over_thresh_pixels > 0 else (per_pixel_max > 0)
        vis[highlight, 0] = 255
        vis[highlight, 1] = 0
        vis[highlight, 2] = 180
        vis[highlight, 3] = 255
        Image.fromarray(vis, mode="RGBA").save(diff_path)

    passed = (over_thresh_ratio <= max_over_threshold_ratio) and (mean_abs_diff <= max_mean_diff)
    reason = None
    if not passed:
        reasons = []
        if over_thresh_ratio > max_over_threshold_ratio:
            reasons.append(f"over_threshold_ratio({over_thresh_ratio:.6f}>{max_over_threshold_ratio})")
        if mean_abs_diff > max_mean_diff:
            reasons.append(f"mean_abs_diff({mean_abs_diff:.4f}>{max_mean_diff})")
        reason = "; ".join(reasons)

    return {
        "mode": mode,
        "passed": passed,
        "reason": reason,
        "baseline_size": list(base_img.size),
        "candidate_size": list(cand_img.size),
        "ref_offset": [ref_offset_x, ref_offset_y] if mode == "static" else None,
        "max_abs_diff": max_abs_diff,
        "mean_abs_diff": round(mean_abs_diff, 6),
        "nonzero_pixels": nonzero_pixels,
        "threshold": max_allowed_diff,
        "over_threshold_pixels": over_thresh_pixels,
        "over_threshold_ratio": round(over_thresh_ratio, 6),
        "total_pixels": total_pixels,
        "over_threshold_bbox": bbox,
        "diff_image": str(diff_path) if (diff_path is not None and nonzero_pixels > 0) else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify F2A AEP static fidelity or animation resting frame.")
    parser.add_argument("baseline", type=Path, help="Baseline PNG (Figma reference for static mode, or static AE render for resting mode)")
    parser.add_argument("candidate", type=Path, help="Candidate AE render PNG")
    parser.add_argument("--mode", choices=["resting", "static"], default="resting", help="Comparison mode")
    parser.add_argument("--diff", type=Path, default=None, help="Optional output PNG highlighting differences")
    parser.add_argument("--ref-offset-x", type=int, default=0, help="Reference layer top-left X in root comp (static mode)")
    parser.add_argument("--ref-offset-y", type=int, default=0, help="Reference layer top-left Y in root comp (static mode)")
    parser.add_argument("--bg", type=str, default="0,0,0", help="Comp background RGB for static compositing (default 0,0,0)")
    parser.add_argument("--max-diff", type=int, default=None, help="Per-pixel channel threshold (default: 2 for resting, 15 for static)")
    parser.add_argument("--max-mean", type=float, default=None, help="Max allowed mean diff (default: 0.05 for resting, 2.0 for static)")
    parser.add_argument("--max-over-ratio", type=float, default=None, help="Max allowed ratio of pixels > max-diff (default: 0.0002 for resting, 0.015 for static)")
    args = parser.parse_args()

    bg_parts = [int(x.strip()) for x in args.bg.split(",")]
    bg_rgb = (bg_parts[0], bg_parts[1], bg_parts[2])

    if args.mode == "resting":
        max_diff = 2 if args.max_diff is None else args.max_diff
        max_mean = 0.05 if args.max_mean is None else args.max_mean
        max_ratio = 0.0002 if args.max_over_ratio is None else args.max_over_ratio
    else:
        max_diff = 15 if args.max_diff is None else args.max_diff
        max_mean = 2.0 if args.max_mean is None else args.max_mean
        max_ratio = 0.015 if args.max_over_ratio is None else args.max_over_ratio

    result = compare_images(
        baseline_path=args.baseline,
        candidate_path=args.candidate,
        mode=args.mode,
        diff_path=args.diff,
        ref_offset_x=args.ref_offset_x,
        ref_offset_y=args.ref_offset_y,
        bg_rgb=bg_rgb,
        max_allowed_diff=max_diff,
        max_mean_diff=max_mean,
        max_over_threshold_ratio=max_ratio,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["passed"] else 2)


if __name__ == "__main__":
    main()
