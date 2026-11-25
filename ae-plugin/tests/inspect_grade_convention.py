"""Which alpha convention reproduces the AE design render of the probe strip?"""

import sys

import numpy as np

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
sys.path.insert(0, ROOT + r"\tests")
from figma_image_grade import grade  # noqa: E402

CONTROLS = np.array([-17, 5, 18, -26, 21, -21, 13]) / 100.0
STRAIGHT = np.array([200, 100, 50], float)
AE = {
    255: np.array([163, 66, 37]),
    200: np.array([129, 52, 24]),
    128: np.array([54, 36, 13]),
    64: np.array([16, 16, 11]),
    32: np.array([4, 4, 4]),
}


def g(encoded):
    return grade(np.clip(encoded, 0, 1).reshape(1, 1, 3), CONTROLS)[0, 0] * 255.0


print(f"{'alpha':>6} {'AE':>18} {'premult/grade*alpha':>22} {'grade(premult)':>20} {'grade(p/a)':>18}")
for a8 in (255, 200, 128, 64, 32):
    a = a8 / 255.0
    premult = np.round(STRAIGHT * a)
    c1 = g(premult / 255.0 / a) * a
    c2 = g(premult / 255.0) * a
    c3 = g(premult / 255.0 / a)
    print(
        f"{a8:>6} {np.array2string(AE[a8], separator=','):>18} "
        f"{np.array2string(np.round(c1, 1), separator=','):>22} "
        f"{np.array2string(np.round(c2, 1), separator=','):>20} "
        f"{np.array2string(np.round(c3, 1), separator=','):>18}"
    )
