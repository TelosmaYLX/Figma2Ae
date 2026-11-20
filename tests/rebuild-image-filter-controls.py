"""Update the seven-control study's native Apply Color LUT effects in an AE XML project."""
import argparse
import hashlib
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image


SIZE = 32
NAMESPACE = "http://www.adobe.com/products/aftereffects"
LABEL = re.compile(r"F2A_(exposure|contrast|saturation|temperature|tint|highlights|shadows)_(-?\d+)")


def lookup_data(capture):
    with Image.open(capture) as image:
        rgba = np.asarray(image.convert("RGBA"))
    if rgba.shape != (128, 256, 4) or not np.all(rgba[..., 3] == 255):
        raise ValueError(f"Expected the opaque 32³ calibration chart in {capture}")
    # Figma chart: red fastest. ICC mAB CLUT: blue fastest.
    table = rgba[..., :3].reshape(SIZE, SIZE, SIZE, 3).transpose(2, 1, 0, 3) / 255
    axis = np.linspace(0, 255, SIZE)
    byte_knots = np.rint(axis)
    lo = np.clip(np.searchsorted(byte_knots, axis, side="right") - 1, 0, SIZE - 2)
    frac = (axis - byte_knots[lo]) / (byte_knots[lo + 1] - byte_knots[lo])
    for dimension in range(3):
        shape = [1] * 4
        shape[dimension] = SIZE
        t = frac.reshape(shape)
        table = table.take(lo, dimension) * (1 - t) + table.take(lo + 1, dimension) * t
    return np.rint(table * 65535).astype(">u2").tobytes()


def update_profile(data, table):
    header = data[:28]
    profile = bytearray(data[28:])
    if profile[36:40] != b"acsp" or struct.unpack_from(">I", profile)[0] != len(profile):
        raise ValueError("Expected the study's embedded ICC profile")
    num_tags = struct.unpack_from(">I", profile, 128)[0]
    tags = dict((tag, offset) for tag, offset, _ in struct.iter_unpack(">4sII", profile[132:132 + 12 * num_tags]))
    ab = tags[b"A2B0"]
    grid = ab + struct.unpack_from(">I", profile, ab + 24)[0]
    if profile[ab:ab + 4] != b"mAB " or profile[grid:grid + 3] != bytes([SIZE]) * 3 or profile[grid + 16] != 2:
        raise ValueError("Expected the study's 32³ 16-bit CLUT")
    profile[grid + 20:grid + 20 + len(table)] = table
    # ICC v4 profile ID calculation excludes flags, rendering intent and the ID itself.
    digest_input = profile.copy()
    for offset, length in [(44, 4), (64, 4), (84, 16)]:
        digest_input[offset:offset + length] = bytes(length)
    profile[84:100] = hashlib.md5(digest_input).digest()
    return header + profile, profile[84:100]


def rebuild(template, captures, destination):
    ET.register_namespace("", NAMESPACE)
    tree = ET.parse(template)
    updated = set()
    for effect in tree.iter(f"{{{NAMESPACE}}}sspc"):
        name = effect.findtext("{*}tdgp/{*}tdsn/{*}string") or ""
        label = LABEL.fullmatch(name)
        if not label:
            continue
        key, value = label.groups()
        data = effect.find("{*}sdat")
        if data is None:
            continue
        capture = next((captures / (key + value)).glob("*.png"))
        raw, profile_id = update_profile(bytes.fromhex(data.attrib["bdata"]), lookup_data(capture))
        data.set("bdata", raw.hex())
        # AE also uses the effect's persistent identifier to cache each transform.
        effect.find("{*}pgui").set("bdata", hashlib.md5(name.encode() + profile_id).hexdigest())
        updated.add((key, int(value)))
    if len(updated) != 140:
        raise ValueError(f"Expected the 140 non-neutral settings, found {len(updated)}")
    with destination.open("xb") as output:
        tree.write(output, encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("captures", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    rebuild(args.template, args.captures, args.destination)
