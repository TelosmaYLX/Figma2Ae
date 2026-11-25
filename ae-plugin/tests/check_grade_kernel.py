"""Compare the plug-in kernel (grade_cli.exe) with the validated NumPy reference.

The CLI prints, for every input colour, the final graded value (0..255 scale).
The reference implementation (tests/figma_image_grade.py) produces the 8-bit PNG
bytes Figma itself would write, including its 12-bit quantisation rule.
"""

import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
TESTS = os.path.join(ROOT, "ae-plugin", "tests")
CLI = os.path.join(TESTS, "grade_cli.exe")
BASE = os.path.join(ROOT, "rea-work", "image-grade")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from figma_image_grade import grade, png_bytes  # noqa: E402

SETS = {
    "P0_design": [-17, 5, 18, -26, 21, -21, 13],
    "P2_extreme": [100, -100, 100, -100, 100, -100, 100],
    "P3_sat": [0, 0, 60, 0, 0, 0, 0],
    "P4_exposure": [-50, 0, 0, 0, 0, 0, 0],
    "P5_warm": [0, 0, 0, 45, -30, 20, -20],
    "P6_mixed": [32, -48, 61, -44, 25, 39, -67],
    "P7_contrast": [0, 70, 0, 0, 0, 0, 0],
    "P8_shadow": [0, 0, 0, 0, 0, 30, -40],
    "P9_all_neg": [-100, -100, -100, -100, -100, -100, -100],
}


def sample_colors():
    card = np.asarray(Image.open(os.path.join(BASE, "grade_card_512.png")).convert("RGB"))
    colors = card.reshape(-1, 3)[::97]
    rng = np.random.default_rng(11)
    extra = rng.integers(0, 256, size=(2000, 3))
    grey = np.stack([np.arange(0, 256)] * 3, axis=-1)
    return np.unique(np.vstack([colors, extra, grey]), axis=0)


def run_cli(controls, colors):
    stdin = "\n".join(f"{int(c[0])} {int(c[1])} {int(c[2])}" for c in colors) + "\n"
    out = subprocess.run(
        [CLI] + [str(int(round(v))) for v in controls] + ["--straight"],
        input=stdin,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip().splitlines()
    values = np.array([[float(v) for v in line.split()] for line in out], dtype=np.float64)
    return values


def main():
    colors = sample_colors()
    rows = []
    for name, controls in SETS.items():
        decoded = colors.astype(np.float64) / 255.0
        ref = png_bytes(grade(decoded, np.asarray(controls) / 100.0)).astype(np.int32)
        values = run_cli(controls, colors)
        cli_bytes = np.clip(np.floor(values + 0.5), 0, 255).astype(np.int32)
        d = np.abs(cli_bytes - ref)
        rows.append(
            {
                "case": name,
                "controls": controls,
                "channels": int(d.size),
                "exact_pct": round(100.0 * float((d == 0).mean()), 4),
                "mean": round(float(d.mean()), 5),
                "p99": int(np.percentile(d, 99)),
                "max": int(d.max()),
                "max_float_error": round(float(np.abs(values - ref).max()), 3),
            }
        )
    done = [r for r in rows if r["max"] <= 1]
    print(f"{len(done)}/{len(rows)} control sets within 1 code value; worst max = {max(r['max'] for r in rows)}")
    print(json.dumps(rows[:3], indent=1, ensure_ascii=False))
    with open(os.path.join(BASE, "grade_kernel_check.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
