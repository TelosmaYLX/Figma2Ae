"""Compare the "Figma 调色" plug-in renders in AE with the validated NumPy
reference implementation of Figma's image-fill grade.

Reference: tests/figma_image_grade.py (float64, plus the 12-bit PNG quantisation
rule recovered from Figma's export), validated against Figma's own renders in
tests/image-filter-study.md (99.9967% of all RGB channel values exactly).
"""

import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
BASE = os.path.join(ROOT, "rea-work", "image-grade")
AE = os.path.join(BASE, "ae")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from figma_image_grade import grade, png_bytes  # noqa: E402

SETS = {
    "P0_design": [-17, 5, 18, -26, 21, -21, 13],
    "P1_zero": [0, 0, 0, 0, 0, 0, 0],
    "P2_extreme": [100, -100, 100, -100, 100, -100, 100],
    "P3_sat": [0, 0, 60, 0, 0, 0, 0],
    "P4_exposure": [-50, 0, 0, 0, 0, 0, 0],
    "P5_warm": [0, 0, 0, 45, -30, 20, -20],
    "P6_mixed": [32, -48, 61, -44, 25, 39, -67],
}


def load_rgb(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float64) / 255.0


def load_rgba(path):
    img = np.asarray(Image.open(path).convert("RGBA")).astype(np.float64) / 255.0
    return img[..., :3], img[..., 3:]


def reference_rgb(path, controls):
    return png_bytes(grade(load_rgb(path), np.asarray(controls) / 100.0))


def reference_rgba_on_black(path, controls):
    rgb, a = load_rgba(path)
    straight = grade(rgb, np.asarray(controls) / 100.0)
    return png_bytes(straight * a)


def stats(ae, ref, label):
    d = np.abs(ae.astype(np.int32) - ref.astype(np.int32))
    channels = d.size
    exact = int((d == 0).sum())
    out = {
        "case": label,
        "channels": int(channels),
        "exact_channels": exact,
        "exact_pct": round(100.0 * exact / channels, 4),
        "mean": round(float(d.mean()), 4),
        "p99": int(np.percentile(d, 99)),
        "max": int(d.max()),
        "pixels_max": int((d.max(axis=2) > 0).sum()),
        "pixels": int(d.shape[0] * d.shape[1]),
    }
    return out


def main():
    rows = []
    for name, controls in SETS.items():
        ae_path = os.path.join(AE, "card_" + name + ".png")
        if not os.path.exists(ae_path):
            print("missing", ae_path)
            continue
        ae = np.asarray(Image.open(ae_path).convert("RGB"))
        ref = reference_rgb(os.path.join(BASE, "grade_card_512.png"), controls)
        rows.append(stats(ae, ref, "card " + name + f" {controls}"))

    for name, key in (("photo_P0_design.png", "P0_design"), ("photo_P6_mixed.png", "P6_mixed")):
        ae_path = os.path.join(AE, name)
        if os.path.exists(ae_path):
            ae = np.asarray(Image.open(ae_path).convert("RGB"))
            ref = reference_rgb(os.path.join(BASE, "grade_photo.png"), SETS[key])
            rows.append(stats(ae, ref, "photo " + key + f" {SETS[key]}"))

    ae_path = os.path.join(AE, "alpha_P0_on_black.png")
    if os.path.exists(ae_path):
        ae = np.asarray(Image.open(ae_path).convert("RGB"))
        ref = reference_rgba_on_black(os.path.join(BASE, "grade_alpha.png"), SETS["P0_design"])
        rows.append(stats(ae, ref, "alpha on black P0_design"))

    print(json.dumps(rows, indent=1))
    with open(os.path.join(BASE, "grade_metrics.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
