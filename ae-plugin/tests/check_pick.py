"""Compare the user's selected Figma layer with the AE reproduction.

Figma node 505:1201 "Circle_Purple": 520x520 ELLIPSE with a 2560x1440 IMAGE fill
(scaleMode FILL) and the seven image filters
  exposure -0.23, contrast 0.05, saturation -0.21, temperature 0.21,
  tint -0.26, highlights 0.19, shadows -0.28   (Figma UI values -23 .. .. ..)

Figma renders: the node itself (filters applied) and a temporary clone with all
seven filters zeroed (the un-graded baseline; the clone was deleted afterwards).

AE renders: the same source image scaled to FILL, matted by the same ellipse,
through the "Figma 调色" plug-in with the same seven values, plus the effect
disabled for the baseline.

Everything is composited over black first (both renders are straight alpha).
"""

import json
import os

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
BASE = os.path.join(ROOT, "rea-work", "figma-user-pick")
FIG = os.path.join(BASE, "figma")
AE = os.path.join(BASE, "ae")

NODE_ID = "505:1201"


def load_rgba(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.float64) / 255.0


def over_black(rgba):
    return rgba[..., :3] * rgba[..., 3:4]


def stats(a, b, mask, label):
    d = np.abs(a - b)
    dd = d[mask]
    return {
        "case": label,
        "pixels": int(mask.sum()),
        "mean": round(float(dd.mean() * 255.0), 3),
        "p99": round(float(np.percentile(dd, 99) * 255.0), 1),
        "max": round(float(dd.max() * 255.0), 1),
        "identical_pct": round(float(100.0 * (dd == 0).mean()), 2),
    }


def main():
    fig_g = over_black(load_rgba(os.path.join(FIG, NODE_ID.replace(":", "-") + ".png")))
    fig_u = over_black(load_rgba(os.path.join(FIG, "534-557.png")))
    ae_g = over_black(load_rgba(os.path.join(AE, "ae_graded.png")))
    ae_u = over_black(load_rgba(os.path.join(AE, "ae_unfiltered.png")))

    h, w = fig_g.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((xx - w / 2 + 0.5) ** 2 + (yy - h / 2 + 0.5) ** 2)
    interior = dist < (w / 2 - 4)      # away from the ellipse antialiased edge
    ring = (dist >= w / 2 - 4) & (dist < w / 2 + 2)
    outside = dist >= w / 2 + 2

    rows = [
        stats(fig_u, ae_u, interior, "baseline (no grade) - interior: image resampling only"),
        stats(fig_u, ae_u, ring, "baseline (no grade) - ellipse edge"),
        stats(fig_g, ae_g, interior, "graded - interior (the plug-in's job)"),
        stats(fig_g, ae_g, ring, "graded - ellipse edge"),
        stats(fig_g, ae_g, outside, "graded - outside the circle"),
    ]
    for r in rows:
        print(r)
    print()
    print("graded vs figma, whole node:",
          json.dumps(stats(fig_g, ae_g, np.ones((h, w), bool), "graded whole"), ensure_ascii=False))

    # presentation images
    def to_u8(x):
        return np.clip(x * 255.0 + 0.5, 0, 255).astype(np.uint8)

    sep = np.zeros((h, 20, 3), np.uint8)
    side = np.hstack([to_u8(fig_g), sep, to_u8(ae_g)])
    Image.fromarray(side).save(os.path.join(BASE, "side_by_side.png"))

    diff = np.abs(fig_g - ae_g)
    Image.fromarray(np.clip(diff.mean(axis=2) * 255 * 10, 0, 255).astype(np.uint8)).save(
        os.path.join(BASE, "diff_x10.png"))

    base_diff = np.abs(fig_u - ae_u)
    Image.fromarray(np.clip(base_diff.mean(axis=2) * 255 * 10, 0, 255).astype(np.uint8)).save(
        os.path.join(BASE, "diff_baseline_x10.png"))

    out = {
        "node": {"id": NODE_ID, "name": "Circle_Purple", "type": "ELLIPSE", "size": [520, 520]},
        "filters_ui": [-23, 5, -21, 21, -26, 19, -28],
        "source_image": "2560x1440 PNG, scaleMode FILL -> layer scale 36.1111%",
        "rows": rows,
        "graded_whole": stats(fig_g, ae_g, np.ones((h, w), bool), "graded whole node"),
        "composite": "both images composited over black (straight alpha)",
    }
    with open(os.path.join(BASE, "comparison.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
