"""RGB chart and .cube conversion for sample-image-filter-lut.cjs (Pillow, NumPy)."""
import sys

import numpy as np
from PIL import Image


SIZE = 64
AXIS = np.linspace(0, 255, SIZE)
KNOTS = np.rint(AXIS).astype(np.uint8)


def chart():
    blue, green, red = np.meshgrid(KNOTS, KNOTS, KNOTS, indexing="ij")
    return np.stack((red, green, blue), axis=-1).reshape(512, 512, 3)


def read_chart(filename):
    with Image.open(filename) as image:
        return np.asarray(image.convert("RGBA"))


def write_cube(rgb, filename):
    table = rgb.reshape(SIZE, SIZE, SIZE, 3).astype(float)
    # PNG samples sit at integer byte values. .cube assumes exactly uniform input knots.
    lo = np.clip(np.searchsorted(KNOTS, AXIS, side="right") - 1, 0, SIZE - 2)
    frac = (AXIS - KNOTS[lo]) / (KNOTS[lo + 1] - KNOTS[lo])
    for axis in range(3):
        weight_shape = [1] * 4
        weight_shape[axis] = SIZE
        weight = frac.reshape(weight_shape)
        table = table.take(lo, axis=axis) * (1 - weight) + table.take(lo + 1, axis=axis) * weight
    np.savetxt(filename, table.reshape(-1, 3) / 255, fmt="%.7f",
               header=f'LUT_3D_SIZE {SIZE}', comments="")


if __name__ == "__main__":
    command, source, *args = sys.argv[1:]
    if command == "chart":
        Image.fromarray(chart()).save(source)
    else:
        rgba = read_chart(source)
        opaque = rgba.shape == (512, 512, 4) and np.all(rgba[:, :, 3] == 255)
        if command == "identity":
            print("ok" if opaque and np.array_equal(rgba[:, :, :3], chart()) else "mismatch")
        elif command == "cube" and opaque:
            write_cube(rgba[:, :, :3], args[0])
        else:
            raise ValueError("Expected an opaque 512 × 512 RGB chart")
