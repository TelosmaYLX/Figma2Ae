"""Compare measured Figma and AE frames in the single-control study (NumPy)."""
import argparse
import json
from pathlib import Path

import numpy as np


CONTROLS = ("exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows")
WEIGHTS = np.array([0.2126, 0.7152, 0.0722])
XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                [0.2126729, 0.7151522, 0.0721750],
                [0.0193339, 0.1191920, 0.9503041]])
XYZ /= XYZ.sum(axis=1, keepdims=True)
INVERSE_XYZ = np.linalg.inv(XYZ)
CALIBRATION = Path(__file__).with_name("fixtures") / "image-filter-calibration.json"


def predict(rgb, control, percent, curves):
    """Evaluate four measured models. RGB is straight, gamma-encoded and in [0, 1]."""
    p = percent / 100
    linear = rgb ** 2.2
    if control == "saturation":
        luminance = (linear @ WEIGHTS)[..., None]
        chroma = linear - luminance
        if p > 0:
            # Maximum multiple of the chroma vector that still lies in the RGB cube.
            to_black = luminance / np.maximum(-chroma.min(axis=-1, keepdims=True), 1e-12)
            to_white = (1 - luminance) / np.maximum(chroma.max(axis=-1, keepdims=True), 1e-12)
            gain = np.minimum(2, 1 + p * (np.minimum(to_black, to_white) - 1))
        else:
            gain = 1 + p
        linear = luminance + gain * chroma
    elif control in ("temperature", "tint", "contrast"):
        root = np.cbrt(linear @ XYZ.T)
        if control == "temperature":
            root[..., 2] -= 0.15 * p
        elif control == "tint":
            root[..., 0] += 0.06 * p
        else:
            # One measured tone curve per 10 slider points. Equal root offsets
            # preserve the differences between X, Y and Z cube roots.
            index = np.clip((percent + 100) / 10, 0, len(curves) - 1)
            low = int(index)
            fraction = index - low
            curve = (1 - fraction) * curves[low] + fraction * curves[min(low + 1, len(curves) - 1)]
            delta = np.interp(root[..., 1], np.linspace(0, 1, len(curve)), curve)
            root += delta[..., None]
        linear = root ** 3 @ INVERSE_XYZ.T
    else:
        raise ValueError(f"No analytic model for {control}")
    return np.rint(np.clip(linear, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)


def fit_contrast(chart, captures):
    from PIL import Image

    def read_training(path):
        with Image.open(path) as im:
            return np.asarray(im.convert("RGB"))[:32].reshape(-1, 3) / 255

    linear = read_training(chart) ** 2.2
    root = np.cbrt(linear @ XYZ.T)
    quadratic = (root * root) @ INVERSE_XYZ.T
    first = root @ INVERSE_XYZ.T
    knots = np.linspace(0, 1, 65)
    basis = np.maximum(0, 1 - np.abs(root[:, 1, None] - knots) * (len(knots) - 1))
    smoothing = np.diff(np.eye(len(knots)), n=2, axis=0) * 5
    curves = []
    for percent in range(-100, 101, 10):
        if percent == 0:
            curves.append(np.zeros_like(knots))
            continue
        goal = read_training(next((captures / f"contrast{percent}").glob("*.png")))
        target = goal ** 2.2
        valid = (goal > 0) & (goal < 1)
        delta = np.zeros((len(linear), 1))
        # Solve the common cube-root offset from the channels that survived clipping.
        for _ in range(8):
            prediction = linear + 3 * delta * quadratic + 3 * delta**2 * first + delta**3
            gradient = 3 * quadratic + 6 * delta * first + 3 * delta**2
            residual = (target - prediction) * valid
            denominator = np.maximum(1e-8, np.sum(gradient**2 * valid, axis=1, keepdims=True))
            delta += np.clip(np.sum(residual * gradient, axis=1, keepdims=True) / denominator, -.05, .05)
        weight = np.minimum(30, np.sqrt(np.sum((gradient / np.maximum(goal, .01)**1.2)**2 * valid, axis=1)))
        weight[(root[:, 1] == 0) & (weight == 0)] = .05
        # Fit a smooth, one-dimensional curve in the original byte quantization scale.
        system = np.vstack((basis * weight[:, None], smoothing))
        values = np.r_[delta[:, 0] * weight, np.zeros(len(smoothing))]
        curves.append(np.linalg.lstsq(system, values, rcond=None)[0])
    return np.asarray(curves)


def neutral_matches(source, reference):
    from PIL import Image

    with Image.open(source) as src, Image.open(reference) as ref:
        a, b = np.asarray(src.convert("RGBA")), np.asarray(ref.convert("RGBA"))
    if a.shape != b.shape or not np.array_equal(a[..., 3], b[..., 3]):
        return False
    opaque = a[..., 3] == 255
    return np.array_equal(a[..., :3][opaque], b[..., :3][opaque])


def stats(differences):
    absolute = np.abs(differences)
    return {"mean": round(float(absolute.mean()), 4),
            "p99": round(float(np.percentile(absolute, 99)), 4),
            "max": round(float(absolute.max()), 4)}


def compare(path):
    curves = np.asarray(json.loads(CALIBRATION.read_text("utf-8"))["contrast_offsets"])
    result = {}
    with np.load(path, allow_pickle=False) as data:
        values = data["values"]
        source = data["source"]
        opaque = source[..., 3] == 255
        # The lower 32 rows form the separate alpha ramp, including its opaque endpoint.
        opaque[96:] = False
        rgb = source[..., :3][opaque].astype(float) / 255
        for key in CONTROLS:
            target = data[f"figma_{key}"].astype(np.int16)
            native = data[f"direct_{key}"].astype(np.int16)
            sampled = data[f"sampled_{key}"].astype(np.int16)
            reference = target[..., :3][:, opaque]
            result[key] = {
                "single_ae_effect": stats(native[..., :3][:, opaque] - reference),
                "sampled_ae_effects": stats(sampled[..., :3][:, opaque] - reference),
                "max_alpha_error": int(np.abs(sampled[..., 3] - target[..., 3]).max()),
            }
            if key in ("contrast", "temperature", "tint", "saturation"):
                model = np.stack([predict(rgb, key, v, curves) for v in values])
                result[key]["model"] = stats(model - reference)
            if f"math_{key}" in data:
                tested = values < 0 if key == "saturation" else np.ones(len(values), dtype=bool)
                frames = data[f"math_{key}"].astype(np.int16)
                result[key]["ae_math_effects"] = stats(frames[..., :3][:, opaque] - reference[tested])
        for name in ("neutral", "combo0", "combo1", "combo2", "combo3"):
            target, sampled = (data[f"{tool}_{name}"].astype(np.int16) for tool in ("figma", "sampled"))
            result[name] = {"sampled_ae_effects": stats((sampled[..., :3] - target[..., :3])[opaque]),
                            "max_alpha_error": int(np.abs(sampled[..., 3] - target[..., 3]).max())}
            if f"joint64_{name}" in data:
                joint = data[f"joint64_{name}"].astype(np.int16)
                result[name]["joint_64_lut"] = stats((joint[..., :3] - target[..., :3])[opaque])
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("compare").add_argument("measurements", type=Path)
    fit = commands.add_parser("fit-contrast")
    fit.add_argument("chart", type=Path)
    fit.add_argument("captures", type=Path)
    neutral = commands.add_parser("neutral")
    neutral.add_argument("source", type=Path)
    neutral.add_argument("reference", type=Path)
    args = parser.parse_args()
    if args.command == "compare":
        print(json.dumps(compare(args.measurements), indent=2, ensure_ascii=False))
    elif args.command == "fit-contrast":
        print(json.dumps(fit_contrast(args.chart, args.captures).round(9).tolist()))
    else:
        print("ok" if neutral_matches(args.source, args.reference) else "mismatch")
