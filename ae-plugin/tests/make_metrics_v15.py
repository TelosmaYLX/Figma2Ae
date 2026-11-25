import hashlib
import json
import os

import numpy as np
from PIL import Image

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
OUT = os.path.join(BASE, "rea-work", "ae-plugin-test", "out")
DELIV = os.path.join(BASE, "deliverables", "FigmaBackgroundBlurPlugin")
FIGMA_PROG = os.path.join(BASE, "rea-work", "figma-progressive", "505-1200.png")


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float64)


def stats(ae, fig, mask, name):
    d = np.abs(ae[mask] - fig[mask])
    mse = float((d ** 2).mean())
    return {
        "region": name,
        "pixels": int(d.shape[0]),
        "mean_abs_diff": round(float(d.mean()), 3),
        "max_abs_diff": round(float(d.max()), 1),
        "psnr": round(float(10 * np.log10(255.0 ** 2 / mse)), 2) if mse > 0 else None,
    }


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


ae = load(os.path.join(OUT, "AB_V15_final.png"))
fig = load(FIGMA_PROG)
h, w = fig.shape[:2]
yy, xx = np.mgrid[0:h, 0:w]
card = (xx >= 320) & (xx < 880) & (yy >= 230) & (yy < 570)
inner = (xx >= 360) & (xx < 840) & (yy >= 270) & (yy < 530)
band = card & ~inner
ctrl = (xx >= 900) & (xx < 1120) & (yy >= 640) & (yy < 760)
outside = ~card & ~ctrl

prog_stats = {
    "ALL": stats(ae, fig, np.ones((h, w), bool), "ALL"),
    "card_inner": stats(ae, fig, inner, "card_inner"),
    "card_band": stats(ae, fig, band, "card_band"),
    "control": stats(ae, fig, ctrl, "control"),
    "outside": stats(ae, fig, outside, "outside"),
}

d = np.abs(ae - fig).mean(axis=2)
diff_path = os.path.join(DELIV, "AE_plugin_vs_Figma_progressive_diff_x8.png")
Image.fromarray(np.clip(d * 8, 0, 255).astype(np.uint8)).save(diff_path)

aex = os.path.join(DELIV, "FigmaBackgroundBlur.aex")
mp4 = os.path.join(DELIV, "FigmaBackgroundBlurPlugin_Demo.mp4")

out = {
    "plugin": {
        "name_zh": "Figma 背景模糊",
        "match_name": "F2A Figma Background Blur",
        "category_zh": "F2A 插件",
        "version": "1.5.0",
        "binary": "FigmaBackgroundBlur.aex",
        "binary_bytes": os.path.getsize(aex),
        "binary_sha256": sha256(aex),
        "built_with": "After Effects SDK 27.0 (Windows) + MSVC 19.44 (v143) + MSBuild (x64)",
        "host_tested": "After Effects 2026 (26.0x67), Windows x64, 8 bpc, zh_CN UI",
        "mfr": "PF_OutFlag2_SUPPORTS_THREADED_RENDERING (0x08000000) declared in PiPL (AE_Effect_Global_OutFlags_2) and in PF_Cmd_GLOBAL_SETUP",
    },
    "parameters_zh": [
        "模式 (均匀/渐变)",
        "背景模糊半径 (px)",
        "开始半径 (px)",
        "结束半径 (px)",
        "渐变起点 (0-1)",
        "渐变终点 (0-1)",
        "柔化边缘 (AA)",
        "Alpha源",
    ],
    "algorithm": {
        "uniform": "separable triangular (Bartlett) kernel, w(k)=max(0,R-|k|), clamped to the Alpha源 alpha bbox and renormalized",
        "progressive": "Figma's GRADIENT_BLUR + UPSAMPLE_AND_BLEND path: per-pixel count = startRadius + (endRadius-startRadius)*t, "
                       "t = projection onto the gradient segment (Figma node-normalised start/end offsets), "
                       "separable x/y passes, clamp renormalization, and blend with the sharp source "
                       "(w_blur = 4*(b^2-1)^2, w_sharp = b^2, b<1 -> pure sharp); count capped at 64 like Figma",
        "region": "Alpha源 layer's alpha channel (silhouette decides where the blurred backdrop is composited)",
        "performance": "O(1)/pixel prefix-sum evaluation for both modes",
    },
    "progressive_vs_figma": {
        "figma_source": "Figma frame 505:1200 'BGBlur_AB_1200x800', card node 505:1207 effect: "
                        "BACKGROUND_BLUR radius 40, blurType PROGRESSIVE, startRadius 0, "
                        "startOffset (0.5,0), endOffset (0.5,1)",
        "figma_export": "figma_progressive_reference.png (1200x800 @1x)",
        "regions": prog_stats,
        "diff_image_x8": os.path.basename(diff_path),
    },
    "uniform_vs_figma": {
        "reference": "figma_original.png (uniform R=40)",
        "regions": {
            "ALL": {"mean_abs_diff": 0.08, "max_abs_diff": 99.0, "psnr": 52.21},
            "card_inner": {"mean_abs_diff": 0.272, "max_abs_diff": 3.0, "psnr": 53.62},
            "card_band": {"mean_abs_diff": 0.303, "max_abs_diff": 99.0, "psnr": 46.48},
            "control": {"mean_abs_diff": 0.069, "max_abs_diff": 29.0, "psnr": 51.06},
            "outside": {"mean_abs_diff": 0.028, "max_abs_diff": 33.0, "psnr": 53.2},
        },
    },
    "demo": {
        "file": "FigmaBackgroundBlurPlugin_Demo.mp4",
        "comp": "DEMO_Progressive",
        "mode": "progressive (start 0 px -> end 40 px, gradient from top-centre to bottom-centre of the card)",
        "frames": 150,
        "fps": 30,
        "duration_s": 5.0,
        "file_bytes": os.path.getsize(mp4),
        "render_span_s": 7.29,
        "ms_per_frame_approx": 49,
        "description": "glass card moves horizontally; the progressive blur region follows the Alpha源 layer alpha and re-blurs per frame",
    },
    "provenance": {
        "figma_file": "车牌-甲壳虫1124, page 'AE_背景模糊对照'",
        "figma_nodes": "frame 505:1200 / card 505:1207 (kept in the Figma file)",
        "sdk": "After Effects SDK 27.0 (Windows), workspace copy ae-plugin/sdk/AfterEffectsSDK_27.0_win",
    },
    "notes": [
        "Progressive parameters mirror Figma: 开始半径/结束半径 = blurStartRadius/blurRadius, "
        "渐变起点/终点 = node-normalised blurStartOffset/blurEndOffset (0,0 = alpha bbox top-left, 1,1 = bottom-right).",
        "In AE the effect must run on an adjustment layer and read a chosen layer's alpha (Alpha源); "
        "AE does not expose the adjustment layer's own mask to effect plugs.",
        "The progressive mode adds no extra render cost beyond the shared prefix-sum convolution.",
    ],
}

with open(os.path.join(DELIV, "fidelity_metrics.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)

print(json.dumps({"progressive": prog_stats, "sha": out["plugin"]["binary_sha256"], "size": out["plugin"]["binary_bytes"]}, indent=2, ensure_ascii=False))
