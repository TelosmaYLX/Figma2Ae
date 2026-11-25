"""Grade-only check on the user's actual image at native resolution.

The Figma node's image fill is a 2560x1440 PNG. This compares the AE render
(source at 100% + "Figma 调色" with the node's seven values, composited over
black) with the NumPy reference implementation of Figma's shader - the same
reference that was validated against Figma's own PNG exports.
"""

import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
BASE = os.path.join(ROOT, "rea-work", "figma-user-pick")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from figma_image_grade import grade, png_bytes  # noqa: E402

CONTROLS = np.array([-23, 5, -21, 21, -26, 19, -28]) / 100.0
SRC = os.path.join(BASE, "source", "481ada345282c1b47e5d36dd188f55a09c72b2df.png")
AE = os.path.join(BASE, "ae", "ae_native.png")


def main():
    src = np.asarray(Image.open(SRC).convert("RGBA")).astype(np.float64) / 255.0
    ref = png_bytes(grade(src[..., :3], CONTROLS)).astype(np.int32)
    ae = np.asarray(Image.open(AE).convert("RGB")).astype(np.int32)
    if ae.shape != ref.shape:
        print("size mismatch", ae.shape, ref.shape)
        return
    d = np.abs(ae - ref)
    row = {
        "case": "native 2560x1440, user's image, filters [-23,5,-21,21,-26,19,-28]",
        "pixels": int(d.shape[0] * d.shape[1]),
        "channels": int(d.size),
        "mean": round(float(d.mean()), 4),
        "p99": int(np.percentile(d, 99)),
        "max": int(d.max()),
        "identical_pct": round(100.0 * float((d == 0).mean()), 3),
        "pixels_with_diff": int((d.max(axis=2) > 0).sum()),
    }
    print(json.dumps(row, indent=1, ensure_ascii=False))
    with open(os.path.join(BASE, "native_check.json"), "w", encoding="utf-8") as f:
        json.dump(row, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
