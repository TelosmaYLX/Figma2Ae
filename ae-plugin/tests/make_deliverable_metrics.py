import hashlib
import json
import os

import numpy as np
from PIL import Image

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
OUT = os.path.join(BASE, "rea-work", "ae-plugin-test", "out")
DELIV = os.path.join(BASE, "deliverables", "FigmaBackgroundBlurPlugin")
FIGMA = os.path.join(BASE, "rea-work", "figma-ab", "figma_original_1x.png")
METRICS_IN = os.path.join(BASE, "rea-work", "ae-plugin-test", "plugin_metrics.json")


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float64)


def make_diff(plugin_png, out_png, amp=8.0):
    a = load(os.path.join(OUT, plugin_png))
    f = load(FIGMA)
    d = np.abs(a - f).mean(axis=2)
    img = np.clip(d * amp, 0, 255).astype(np.uint8)
    Image.fromarray(img).save(out_png)
    return {
        "source": plugin_png,
        "output": os.path.basename(out_png),
        "amplification": amp,
        "mean_abs_diff": round(float(d.mean()), 4),
        "max_abs_diff": round(float(d.max()), 2),
        "pixels_gt2_pct": round(float((d > 2).mean() * 100), 3),
        "pixels_gt8_pct": round(float((d > 8).mean() * 100), 3),
    }


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    with open(METRICS_IN, encoding="utf-8") as f:
        metrics = json.load(f)

    diffs = [
        make_diff("AB_R40_HARD.png", os.path.join(DELIV, "AE_plugin_vs_Figma_diff_x8_hardEdge.png"), 8.0),
        make_diff("AB_R40_SOFT.png", os.path.join(DELIV, "AE_plugin_vs_Figma_diff_x8_softEdge.png"), 8.0),
    ]

    out = {
        "plugin": {
            "name_zh": "Figma 背景模糊",
            "name_pipl": "Figma 背景模糊",
            "match_name": "F2A Figma Background Blur",
            "category_zh": "F2A 插件",
            "version": "1.1.0",
            "binary": "FigmaBackgroundBlur.aex",
            "binary_bytes": 36864,
            "binary_sha256": sha256(os.path.join(DELIV, "FigmaBackgroundBlur.aex")),
            "built_with": "After Effects SDK 27.0 (Windows) + MSVC 19.44 (v143) + MSBuild (x64)",
            "host_tested": "After Effects 2026 (26.0x67), Windows x64, 8 bpc project, zh_CN UI",
            "installed_to": r"D:\Software\Adobe\Adobe After Effects 2026\Support Files\Plug-ins\F2A\FigmaBackgroundBlur.aex",
            "ui_strings": "UTF-8 (PF_OutFlag2_STRINGS_ARE_UTF8); PiPL name/category patched to CP936 for Chinese Windows",
        },
        "algorithm": {
            "kernel": "separable triangular (Bartlett): w(k)=max(0, R-|k|), normalized by the used-weight sum",
            "passes": "horizontal then vertical",
            "clamp": "taps outside the shape bounds are dropped and the remaining weights re-normalized (Figma clamp)",
            "mask": "rounded rectangle, analytic 1px AA coverage; hard (Figma-like) or soft blend at the edge",
            "radius_meaning": "R in composition pixels = triangular kernel half-width (Figma radius x render scale)",
            "performance": {
                "implementation": "O(1)/pixel prefix-sum evaluation of the triangular kernel + clamp (v1.1)",
                "multi_frame_rendering": "PF_OutFlag2_SUPPORTS_THREADED_RENDERING; render is stateless/re-entrant",
                "demo_render": {
                    "frames": 150,
                    "resolution": "1200x800",
                    "total_seconds": 8.2,
                    "ms_per_frame_approx": 55,
                    "note": "AE CompItem.saveFrameToPng per frame (includes whole-scene compositing + PNG write); v1.0 was 13.4 s / ~90 ms per frame",
                },
            },
            "parameters_zh": [
                "背景模糊半径 (px)",
                "中心 X",
                "中心 Y",
                "形状宽度",
                "形状高度",
                "圆角半径",
                "柔化边缘 (AA)",
            ],
        },
        "calibration": {
            "impulse_R8": metrics["impulse_r8"],
            "step_R40": metrics["step_r40"],
        },
        "ab_vs_figma": {
            "figma_source": "figma_original.png (1200x800 export of Figma frame BGBlur_AB_1200x800, background blur R=40)",
            "variants": metrics["variants"],
            "diff_images": diffs,
        },
        "demo_video": {
            "file": "FigmaBackgroundBlurPlugin_Demo.mp4",
            "comp": "DEMO_Realtime_MovingGlassCard",
            "codec": "H.264 (libx264, yuv420p, crf16, faststart)",
            "size": "1200x800",
            "fps": 30,
            "frames": 150,
            "duration_s": 5.0,
            "file_bytes": 212508,
            "source": "150 frames rendered from AE (plugin re-computed per frame), encoded with ffmpeg",
        },
        "provenance": {
            "figma_ab_scene": "Figma file (车牌-甲壳虫1124), page 'AE_背景模糊对照', frame 505:1200 'BGBlur_AB_1200x800' (kept, not deleted)",
            "figma_export": "1200x800 PNG, background blur radius=40",
            "ae_project": "FigmaBackgroundBlurPlugin_Demo.aep (01_Demo / 02_Reference / 03_Compare / 04_Calibration)",
            "plugin_source": "src/ + tools/patch_pipl_name.py (PiPL name/category patch) + build.ps1",
            "sdk": "After Effects SDK 27.0 (Windows), workspace copy ae-plugin/sdk/AfterEffectsSDK_27.0_win",
        },
        "notes": [
            "Hard edge = Figma-faithful discard semantics; Soft AA Edge gives lower global/edge error in this test.",
            "AE shape layers have no 'inside stroke' property in scripting; the card stroke is emulated with an inset stroke layer.",
            "The PiPL Name/Category of this build are patched to CP936 after compilation because AE decodes PiPL strings with the system ANSI code page on Chinese Windows; parameter names use UTF-8 via PF_OutFlag2_STRINGS_ARE_UTF8.",
            "Figma's renderer internally uses a 0.5x downsample path for radii > 4 texels (measured ~2-4% narrower kernel); this plug-in computes the exact full-resolution triangular kernel.",
        ],
    }

    with open(os.path.join(DELIV, "fidelity_metrics.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print(json.dumps({
        "plugin_sha256": out["plugin"]["binary_sha256"],
        "diff": diffs,
        "hard_ALL": metrics["variants"]["AB_R40_HARD"]["ALL"],
        "hard_card_inner": metrics["variants"]["AB_R40_HARD"]["card_inner"],
        "soft_ALL": metrics["variants"]["AB_R40_SOFT"]["ALL"],
        "soft_band": metrics["variants"]["AB_R40_SOFT"]["card_band"],
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
