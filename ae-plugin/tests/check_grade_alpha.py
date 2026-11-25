"""Diagnose the alpha path of the Figma image-grade plug-in.

Compares the AE render of the RGBA test image (over black) with the reference,
split by the source alpha value, for both the identity setting and the design
setting.
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

CONTROLS = np.asarray([-17, 5, 18, -26, 21, -21, 13]) / 100.0

img = np.asarray(Image.open(os.path.join(BASE, "grade_alpha.png")).convert("RGBA")).astype(np.float64) / 255.0
rgb, a = img[..., :3], img[..., 3]


def ref(graded):
    straight = grade(rgb, CONTROLS) if graded else rgb
    return png_bytes(straight * a[..., None])


def report(ae_path, graded, label):
    ae = np.asarray(Image.open(ae_path).convert("RGB")).astype(np.int32)
    r = ref(graded).astype(np.int32)
    d = np.abs(ae - r)
    a8 = np.round(a * 255).astype(np.int32)
    rows = []
    for band, mask in (
        ("alpha=255", a8 == 255),
        ("alpha=254..200", (a8 <= 254) & (a8 >= 200)),
        ("alpha=199..100", (a8 <= 199) & (a8 >= 100)),
        ("alpha=99..1", (a8 <= 99) & (a8 >= 1)),
        ("alpha=0", a8 == 0),
    ):
        if mask.sum() == 0:
            continue
        dm = d[mask]
        rows.append(
            {
                "band": band,
                "pixels": int(mask.sum()),
                "mean": round(float(dm.mean()), 3),
                "p99": int(np.percentile(dm, 99)),
                "max": int(dm.max()),
                "exact_pct": round(float(100.0 * (dm == 0).mean()), 3),
            }
        )
    print(label)
    print(json.dumps(rows, indent=1))
    return rows


if __name__ == "__main__":
    rows = {}
    rows["identity"] = report(os.path.join(AE, "alpha_P1_on_black.png"), False, "identity (all seven = 0)")
    rows["design"] = report(os.path.join(AE, "alpha_P0_on_black.png"), True, "design setting")
    with open(os.path.join(BASE, "grade_alpha_diag.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1, ensure_ascii=False)
