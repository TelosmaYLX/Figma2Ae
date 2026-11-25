"""Generate the validation images for the Figma image-grade plug-in.

- grade_card_512.png : 512x512 = 262,144 colours (64 levels per channel, step 4)
- grade_photo.png    : 1200x800 photo-like image (gradients, blobs, saturated patches, noise)
- grade_alpha.png    : 800x600 RGBA image with a soft-edged alpha (premultiply test)
"""

import numpy as np
from PIL import Image

OUT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\rea-work\image-grade"


def card():
    y, x = np.mgrid[0:512, 0:512]
    v = (y * 512 + x).astype(np.int32)
    r = ((v >> 12) & 63) * 4
    g = ((v >> 6) & 63) * 4
    b = (v & 63) * 4
    img = np.stack([r, g, b], axis=-1).astype(np.uint8)
    Image.fromarray(img, "RGB").save(OUT + r"\grade_card_512.png")
    print("card", img.shape, img.reshape(-1, 3).shape)


def photo():
    h, w = 800, 1200
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    # smooth background gradient: dark blue -> purple -> teal
    t = (x / (w - 1)) * 0.7 + (y / (h - 1)) * 0.3
    img = np.stack([20 + 90 * t, 18 + 60 * t, 43 + 120 * t], axis=-1)

    def blob(cx, cy, rx, ry, color, soft=1.0):
        d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
        a = np.clip(1.15 - d, 0, 1) ** (1.0 / soft)
        return a[..., None], np.array(color, float)

    for cx, cy, rx, ry, color in [
        (300, 250, 260, 220, (108, 92, 231)),
        (880, 220, 240, 200, (0, 194, 203)),
        (950, 620, 200, 170, (225, 112, 85)),
        (180, 640, 220, 160, (253, 203, 110)),
        (600, 380, 180, 180, (255, 255, 255)),
    ]:
        a, c = blob(cx, cy, rx, ry, color)
        img = img * (1 - a) + c * a

    # saturated patches and a small checkerboard for gamut stress
    img[80:180, 540:720] = np.array([255, 40, 40])
    img[80:180, 740:920] = np.array([40, 255, 90])
    img[80:180, 940:1120] = np.array([60, 90, 255])
    cb = ((x[620:740, 40:200] // 16 + y[620:740, 40:200] // 16) % 2)[..., None]
    img[620:740, 40:200] = np.where(cb > 0, 240, 12)

    # fine detail + sensor-noise-like grain (shows banding / contrast artifacts)
    rng = np.random.default_rng(7)
    img += rng.normal(0.0, 3.2, img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)
    Image.fromarray(img, "RGB").save(OUT + r"\grade_photo.png")
    print("photo", img.shape)


def alpha():
    h, w = 600, 800
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    rgb = np.zeros((h, w, 3), np.float64)
    rgb[...] = np.stack([40 + 180 * (x / w), 30 + 150 * (y / h), 90 + 120 * (1 - x / w)], axis=-1)
    # soft alpha disc + hard-edged ring: exercises the unpremultiply path
    d = np.sqrt((x - 400) ** 2 + (y - 300) ** 2)
    a = np.clip((260 - d) / 90.0, 0, 1)
    ring = (np.abs(d - 300) < 18).astype(float)
    a = np.clip(a + ring, 0, 1)
    img = np.dstack([np.clip(rgb, 0, 255), a * 255]).astype(np.uint8)
    Image.fromarray(img, "RGBA").save(OUT + r"\grade_alpha.png")
    print("alpha", img.shape)


if __name__ == "__main__":
    import os

    os.makedirs(OUT, exist_ok=True)
    card()
    photo()
    alpha()
