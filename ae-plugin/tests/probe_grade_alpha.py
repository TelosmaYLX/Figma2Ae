"""Probe how After Effects hands straight-alpha footage to the effect.

Creates a small RGBA strip (constant colour, decreasing alpha), renders it through
the plug-in over black, and compares the result with two hypotheses:
  A) the effect receives PREMULTIPLIED pixels  (plug-in divides by alpha)
  B) the effect receives STRAIGHT pixels       (plug-in must not divide)
"""

import os
import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
BASE = os.path.join(ROOT, "rea-work", "image-grade")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from figma_image_grade import grade, png_bytes  # noqa: E402

CONTROLS = np.asarray([-17, 5, 18, -26, 21, -21, 13]) / 100.0
COLOURS = [(200, 100, 50), (40, 180, 230), (250, 240, 20), (255, 255, 255)]
ALPHAS = [255, 200, 128, 64, 32, 16, 8, 4, 2, 1]


def make_strip():
    h = len(COLOURS)
    w = len(ALPHAS)
    img = np.zeros((h, w, 4), np.uint8)
    for y, c in enumerate(COLOURS):
        for x, a in enumerate(ALPHAS):
            img[y, x] = [c[0], c[1], c[2], a]
    path = os.path.join(BASE, "grade_alpha_probe.png")
    Image.fromarray(img, "RGBA").save(path)
    return path, img


def hypothesis_premult(img):
    """plug-in receives premultiplied, divides by alpha, grades, premultiplies"""
    out = np.zeros((img.shape[0], img.shape[1], 3))
    for y in range(img.shape[0]):
        for x in range(img.shape[1]):
            a = img[y, x, 3] / 255.0
            if a <= 0:
                continue
            # AE premultiplies in 8 bit: p8 = round(straight8 * a)
            p = np.array([np.round(img[y, x, c] * a) / 255.0 for c in range(3)])
            s = p / a  # plug-in un-premultiplies
            g = grade(s.reshape(1, 1, 3), CONTROLS)[0, 0]
            out[y, x] = np.clip(g * a, 0, 1)
    return png_bytes(out)


def hypothesis_straight(img):
    """plug-in receives straight pixels (no premultiplication by the host)"""
    out = np.zeros((img.shape[0], img.shape[1], 3))
    for y in range(img.shape[0]):
        for x in range(img.shape[1]):
            a = img[y, x, 3] / 255.0
            s = np.array([img[y, x, c] / 255.0 for c in range(3)])
            if a > 0:
                s = s / a  # what the plug-in does today (wrong for straight input)
            g = grade(np.clip(s, 0, 1).reshape(1, 1, 3), CONTROLS)[0, 0]
            out[y, x] = np.clip(g * a, 0, 1)
    return png_bytes(out)


def main():
    path, img = make_strip()
    ae_path = os.path.join(BASE, "ae", "alpha_probe.png")
    ae = np.asarray(Image.open(ae_path).convert("RGB")).astype(np.int32)
    for name, ref in (("premultiplied input", hypothesis_premult(img)),
                      ("straight input", hypothesis_straight(img))):
        d = np.abs(ae - ref.astype(np.int32))
        print(f"{name:22s} mean {d.mean():.3f} max {d.max()}")
        print("  AE row0:", ae[0].tolist())
        print("  ref row0:", ref[0].tolist())
    print("  src row0:", img[0].tolist())


if __name__ == "__main__":
    main()
