"""Read the probe3 render: red = graded straight, green = alpha, blue = 0 (opaque)."""

import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
sys.path.insert(0, ROOT + r"\tests")
from figma_image_grade import grade  # noqa: E402

CONTROLS = np.array([-17, 5, 18, -26, 21, -21, 13]) / 100.0
src = np.asarray(Image.open(ROOT + r"\rea-work\image-grade\grade_alpha_probe.png").convert("RGBA"))
out = np.asarray(Image.open(ROOT + r"\rea-work\image-grade\ae\probe3.png").convert("RGB"))

print("src row0:", src[0].tolist())
print("probe3 row0 (graded straight, alpha, 0):", out[0].tolist())

# reference graded straight, straight from the PNG data
for x in range(5):
    c = src[0, x, :3] / 255.0
    g = grade(c.reshape(1, 1, 3), CONTROLS)[0, 0] * 255.0
    print(f"  x={x} alpha={src[0, x, 3]:3d}  reference graded straight={np.round(g, 1).tolist()}"
          f"  probe3={out[0, x, :2].tolist()}")
