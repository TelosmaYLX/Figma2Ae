"""Inspect the AE alpha probe renders against the premultiplied model."""

import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
sys.path.insert(0, ROOT + r"\tests")
from figma_image_grade import grade  # noqa: E402

CONTROLS = np.array([-17, 5, 18, -26, 21, -21, 13]) / 100.0


def model(straight8, a8):
    """AE: premultiplies 8-bit straight -> premult; plug-in unpremultiplies,
    grades, premultiplies; comp composites premultiplied over black."""
    a = a8 / 255.0
    p = np.round(np.array(straight8, float) * a) / 255.0
    s = p / a if a > 0 else p
    g = grade(np.clip(s, 0, 1).reshape(1, 1, 3), CONTROLS)[0, 0]
    return np.clip(g * a, 0, 1) * 255


print("model (200,100,50) by alpha:")
for a8 in (255, 200, 128, 64, 32, 16):
    print("  alpha", a8, np.round(model((200, 100, 50), a8), 1).tolist())

diag = np.asarray(Image.open(ROOT + r"\rea-work\image-grade\ae\alpha_probe_diag.png").convert("RGBA"))
print("diag (input premult, alpha, input green) row0:", diag[0, :5, :].tolist())

out = np.asarray(Image.open(ROOT + r"\rea-work\image-grade\ae\alpha_probe.png").convert("RGBA"))
print("design render (no bg) row0 RGBA:", out[0, :6, :].tolist())

out2 = np.asarray(Image.open(ROOT + r"\rea-work\image-grade\ae\alpha_P0_on_black.png").convert("RGBA"))
print("design on black row0 RGBA:", out2[0, :6, :].tolist())
