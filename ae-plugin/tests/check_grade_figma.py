"""End-to-end check: real Figma export vs the AE plug-in render.

Figma's own PNG export (with the seven image-fill filters applied) is compared
with the AE render of the same source image through the "Figma 调色" plug-in,
using the same seven values. F2A MCP was used to build the Figma node and export
it, so this closes the loop on top of the NumPy-model validation.
"""

import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
BASE = os.path.join(ROOT, "rea-work", "image-grade")
AE = os.path.join(BASE, "ae")
FIGMA = os.path.join(BASE, "figma")

# neutral grey reference for the LUT-style comparison (AE render uses the PNG above)


def compare(ae_path, figma_path, label, roi=None):
    ae = np.asarray(Image.open(ae_path).convert("RGB")).astype(np.int32)
    fg = np.asarray(Image.open(figma_path).convert("RGB")).astype(np.int32)
    if ae.shape != fg.shape:
        return {"case": label, "error": f"size mismatch {ae.shape} vs {fg.shape}"}
    d = np.abs(ae - fg)
    if roi is not None:
        x0, y0, x1, y1 = roi
        d = d[y0:y1, x0:x1]
    return {
        "case": label,
        "channels": int(d.size),
        "exact_pct": round(100.0 * float((d == 0).mean()), 3),
        "mean": round(float(d.mean()), 4),
        "p99": int(np.percentile(d, 99)),
        "max": int(d.max()),
        "pixels_with_diff": int((d.max(axis=2) > 0).sum()),
        "pixels": int(d.shape[0] * d.shape[1]),
    }


def main():
    rows = []
    card_ae = os.path.join(AE, "card_P0_design.png")
    card_fg = os.path.join(FIGMA, "532-554.png")
    if os.path.exists(card_ae) and os.path.exists(card_fg):
        rows.append(compare(card_ae, card_fg, "colour card 512² (262,144 colours), design setting"))

    photo_ae = os.path.join(AE, "photo_P6_mixed.png")
    photo_fg = os.path.join(FIGMA, "532-555.png")
    if os.path.exists(photo_ae) and os.path.exists(photo_fg):
        rows.append(compare(photo_ae, photo_fg, "photo 1200x800, mixed setting [32,-48,61,-44,25,39,-67]"))

    print(json.dumps(rows, indent=1, ensure_ascii=False))
    with open(os.path.join(BASE, "grade_figma_e2e.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
