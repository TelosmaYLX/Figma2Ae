"""Verify the joint formula against real Figma PNG measurements."""
import argparse
import json
from pathlib import Path

import numpy as np

from figma_image_grade import grade, png_bytes


CONTROLS = ("exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows")
CAR_SETTINGS = np.array([-17, 5, 18, -26, 21, -21, 13]) / 100


def histogram(rgb, controls, reference):
    predicted = png_bytes(grade(rgb.astype(np.float64) / 255, controls))
    error = np.abs(predicted.astype(np.int16) - reference)
    return np.bincount(error.ravel(), minlength=256)


def describe(counts):
    total = int(counts.sum())
    return {"channels": total, "exact": int(counts[0]),
            "mean": float(counts @ np.arange(256) / total), "max": int(np.flatnonzero(counts)[-1])}


def verify(path):
    results = {}
    with np.load(path, allow_pickle=False) as data:
        source = data["source"][:96, :, :3]
        for i, key in enumerate(CONTROLS):
            total = np.zeros(256, dtype=np.int64)
            controls = np.zeros(7)
            for value, reference in zip(data["values"], data["figma_" + key]):
                controls[i] = value / 100
                total += histogram(source, controls, reference[:96, :, :3])
            results[key] = describe(total)
        for i, controls in enumerate(data["combo_values"]):
            results[f"combo{i}"] = describe(histogram(source, controls / 100, data[f"figma_combo{i}"][:96, :, :3]))
        results["neutral"] = describe(histogram(source, np.zeros(7), data["figma_neutral"][:96, :, :3]))
    return results


def verify_all_rgb(path):
    from PIL import Image

    with Image.open(path) as im:
        if im.size != (4096, 4096):
            raise ValueError("Expected the full RGB8 chart, with red changing fastest")
        ref = np.asarray(im.convert("RGB")).reshape(-1, 3)
    counts = np.zeros(256, dtype=np.int64)
    for start in range(0, len(ref), 65536):
        index = np.arange(start, start + 65536, dtype=np.int32)
        rgb = np.column_stack((index & 255, (index >> 8) & 255, index >> 16))
        counts += histogram(rgb, CAR_SETTINGS, ref[start:start + len(rgb)])
    return describe(counts)


def verify_stress(measurements, stress):
    with np.load(measurements, allow_pickle=False) as data:
        source = data["source"][:96, :, :3]
    results = {}
    with np.load(stress, allow_pickle=False) as data:
        for group in ("corner", "mixed"):
            counts = np.zeros(256, dtype=np.int64)
            for controls, ref in zip(data[group + "_controls"], data[group + "_rgb"]):
                counts += histogram(source, controls, ref)
            results[group] = describe(counts)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("measurements", type=Path)
    parser.add_argument("--full-rgb", type=Path, help="Figma's full RGB8 export using the red car's seven settings")
    parser.add_argument("--stress", type=Path, help="Figma outputs at the 128 corners and 48 interior control settings")
    args = parser.parse_args()
    result = verify(args.measurements)
    if args.full_rgb:
        result["all_rgb_car_grade"] = verify_all_rgb(args.full_rgb)
    if args.stress:
        result.update(verify_stress(args.measurements, args.stress))
    print(json.dumps(result, indent=2))
