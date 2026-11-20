"""Evaluate the seven image-fill controls described in image-filter-study.md."""
import argparse
from pathlib import Path

import numpy as np


RGB_TO_XYZ = np.array([[.4124564, .3575761, .1804375],
                       [.2126729, .7151522, .0721750],
                       [.0193339, .1191920, .9503041]])
XYZ_TO_RGB = np.array([[3.2404542, -1.5371385, -.4985314],
                       [-.9692660, 1.8760108, .0415560],
                       [.0556434, -.2040259, 1.0572252]])
WHITE = np.array([.95047, 1., 1.08883])
LUMA = np.array([.2126, .7152, .0722])


def grade(encoded_rgb, controls):
    """Apply the joint transform to straight RGB values in [0, 1]."""
    exposure, contrast, saturation, temperature, tint, highlights, shadows = controls
    linear = np.asarray(encoded_rgb) ** 2.2
    distance = linear @ LUMA - .5 ** 2.2
    amount = np.where(distance > 0, highlights, -.999 * shadows)
    ev = exposure + .75 * distance / np.sqrt(1 + 4 * distance**2) * amount

    root = np.cbrt((linear @ RGB_TO_XYZ.T) / WHITE)
    lightness = 116 * root[..., 1] - 16
    ax = 500 * (root[..., 0] - root[..., 1]) + 30 * tint
    bx = 200 * (root[..., 1] - root[..., 2]) + 30 * temperature
    c = .3 * contrast
    if c < 0:
        lightness += -c * ((lightness - 50) * .2 + 50 - lightness)
    else:
        t = np.clip((lightness - 20) / 60, 0, 1)
        target = 100 * t**3 * (6 * t**2 - 15 * t + 10)
        lightness += c * (target - lightness)
    fy = (lightness + 16) / 116
    xyz = WHITE * np.stack((fy + ax / 500, fy, fy - bx / 200), axis=-1)**3
    linear = np.clip(xyz @ XYZ_TO_RGB.T, 0, 1)

    luminance = (linear @ LUMA)[..., None]
    negative = np.minimum(0, ev)[..., None]
    scale = 1 + negative / 16
    gain = (10 ** (2 * ev))[..., None]

    def curve(x):
        return x * gain / (1 + x * (gain - 1))

    mixed = curve(scale * (.25 * linear + .75 * luminance))
    chroma = 3 * (1 + luminance**2 * negative / (.2 - negative))
    linear = np.clip(mixed + (mixed - curve(scale * luminance)) * chroma, 0, 1)

    luminance = (linear @ LUMA)[..., None]
    if saturation <= 0:
        factor = 1 + saturation
    else:
        low = luminance / (luminance - linear.min(axis=-1, keepdims=True) + 1e-6)
        high = (1 - luminance) / (linear.max(axis=-1, keepdims=True) - luminance + 1e-6)
        factor = np.minimum(2, 1 + saturation * (np.minimum(low, high) - 1))
    return np.clip(luminance + (linear - luminance) * factor, 0, 1) ** (1 / 2.2)


def png_bytes(rgb):
    quantized = np.floor(np.clip(rgb, 0, 1) * 4096).astype(np.int32)
    return ((255 * quantized + 2047) >> 12).astype(np.uint8)


def write_cube(path, controls, size):
    axis = np.linspace(0, 1, size)
    green, red = np.meshgrid(axis, axis, indexing="ij")
    with path.open("x", encoding="ascii", newline="\n") as output:
        output.write(f"LUT_3D_SIZE {size}\n")
        for blue in axis:
            points = np.stack((red, green, np.full_like(red, blue)), axis=-1)
            np.savetxt(output, grade(points, controls).reshape(-1, 3), fmt="%.8f")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cube", type=Path)
    parser.add_argument("controls", type=float, nargs=7, metavar="PERCENT",
                        help="exposure contrast saturation temperature tint highlights shadows, from -100 to 100")
    parser.add_argument("--size", type=int, default=64)
    args = parser.parse_args()
    if not all(-100 <= value <= 100 for value in args.controls) or not 2 <= args.size <= 256:
        parser.error("Use seven percentages in [-100, 100] and a grid size from 2 to 256.")
    write_cube(args.cube, np.asarray(args.controls) / 100, args.size)
