import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
OUT = os.path.join(BASE, "rea-work", "ae-plugin-test", "out")
FIGMA_PROG = os.path.join(BASE, "rea-work", "figma-progressive", "505-1200.png")
AE = os.path.join(OUT, "PROBE_V16_prog.png")


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float64)


ae = load(AE)
fig = load(FIGMA_PROG)
print("ae", ae.shape, "figma", fig.shape)
h, w = fig.shape[:2]
yy, xx = np.mgrid[0:h, 0:w]
card = (xx >= 320) & (xx < 880) & (yy >= 230) & (yy < 570)
inner = (xx >= 360) & (xx < 840) & (yy >= 270) & (yy < 530)
band = card & ~inner
ctrl = (xx >= 900) & (xx < 1120) & (yy >= 640) & (yy < 760)
outside = ~card & ~ctrl


def stats(mask, name):
    d = np.abs(ae[mask] - fig[mask])
    mse = float((d ** 2).mean())
    return {
        "region": name,
        "mean_abs_diff": round(float(d.mean()), 3),
        "max_abs_diff": round(float(d.max()), 1),
        "psnr": round(float(10 * np.log10(255.0 ** 2 / mse)), 2) if mse > 0 else None,
    }


regions = {
    "ALL": stats(np.ones((h, w), bool), "ALL"),
    "card_inner": stats(inner, "card_inner"),
    "card_band": stats(band, "card_band"),
    "control": stats(ctrl, "control"),
    "outside": stats(outside, "outside"),
}
for k, v in regions.items():
    print(v)

d = np.abs(ae - fig).mean(axis=2)
Image.fromarray(np.clip(d * 8, 0, 255).astype(np.uint8)).save(os.path.join(OUT, "PROBE_V16_diff_x8.png"))
side = np.concatenate([fig, ae], axis=1)
Image.fromarray(side.astype(np.uint8)).save(os.path.join(OUT, "PROBE_V16_side.png"))
print("wrote diff/side images")
