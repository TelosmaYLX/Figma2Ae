"""Deep-colour regression for the "Figma 调色" plug-in (16/32 bpc).

The card is an 8-bit PNG, so the reference is the same NumPy implementation of
Figma's shader used for the 8-bit validation; a 16/32 bpc project must land on
the same values (the plug-in's deep-colour path is the same maths).
"""

import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
BASE = os.path.join(ROOT, "rea-work", "perf-grade")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from figma_image_grade import grade, png_bytes  # noqa: E402

CONTROLS = np.array([-17, 5, 18, -26, 21, -21, 13]) / 100.0
SRC = os.path.join(ROOT, "rea-work", "image-grade", "grade_card_512.png")


def main():
    src = np.asarray(Image.open(SRC).convert("RGBA")).astype(np.float64) / 255.0
    ref = png_bytes(grade(src[..., :3], CONTROLS)).astype(np.int32)
    rows = []
    for tag in ("16bpc", "32bpc"):
        path = os.path.join(BASE, "v13_card_" + tag + ".png")
        if not os.path.exists(path):
            rows.append({"case": tag, "error": "missing render"})
            continue
        ae = np.asarray(Image.open(path).convert("RGB")).astype(np.int32)
        d = np.abs(ae - ref)
        rows.append(
            {
                "case": tag,
                "mean": round(float(d.mean()), 4),
                "p99": int(np.percentile(d, 99)),
                "max": int(d.max()),
                "identical_pct": round(100.0 * float((d == 0).mean()), 3),
            }
        )
    print(json.dumps(rows, indent=1, ensure_ascii=False))
    with open(os.path.join(BASE, "deep_color_check.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
