import hashlib
import json
import os

import numpy as np
from PIL import Image

BASE = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c"
OUT = os.path.join(BASE, "rea-work", "ae-plugin-test", "out")
DELIV = os.path.join(BASE, "deliverables", "FigmaBackgroundBlurPlugin")
FIGMA = os.path.join(BASE, "rea-work", "figma-ab", "figma_original_1x.png")


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float64)


def region_stats(ae, fig, mask, name):
    d = ae[mask]
    f = fig[mask]
    ad = np.abs(d - f)
    mse = float(np.mean(ad ** 2))
    psnr = float("inf") if mse == 0 else float(10 * np.log10(255.0 ** 2 / mse))
    return {
        "region": name,
        "pixels": int(d.shape[0]),
        "mean_abs_diff": round(float(ad.mean()), 3),
        "max_abs_diff": round(float(ad.max()), 1),
        "psnr": round(psnr, 2) if np.isfinite(psnr) else None,
    }


def make_diff(plugin_png, out_png, amp=8.0):
    a = load(os.path.join(OUT, plugin_png))
    f = load(FIGMA)
    d = np.abs(a - f).mean(axis=2)
    Image.fromarray(np.clip(d * amp, 0, 255).astype(np.uint8)).save(out_png)
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
    a = load(os.path.join(OUT, "AB_V13.png"))
    f = load(FIGMA)
    h, w = f.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    card = (xx >= 320) & (xx < 880) & (yy >= 230) & (yy < 570)
    inner = (xx >= 360) & (xx < 840) & (yy >= 270) & (yy < 530)
    band = card & ~inner
    ctrl = (xx >= 900) & (xx < 1120) & (yy >= 640) & (yy < 760)
    outside = ~card & ~ctrl
    allm = np.ones((h, w), bool)

    stats = {
        "ALL": region_stats(a, f, allm, "ALL"),
        "card_inner": region_stats(a, f, inner, "card_inner"),
        "card_band": region_stats(a, f, band, "card_band"),
        "control": region_stats(a, f, ctrl, "control"),
        "outside": region_stats(a, f, outside, "outside"),
        "red_clamp_zone": region_stats(a, f, (xx >= 325) & (xx < 425) & (yy >= 325) & (yy < 425), "red_clamp_zone"),
    }

    diff = make_diff("AB_V13.png", os.path.join(DELIV, "AE_plugin_vs_Figma_diff_x8.png"), 8.0)

    out = {
        "plugin": {
            "name_zh": "Figma 背景模糊",
            "match_name": "F2A Figma Background Blur",
            "category_zh": "F2A 插件",
            "version": "1.3.0",
            "binary": "FigmaBackgroundBlur.aex",
            "binary_bytes": os.path.getsize(os.path.join(DELIV, "FigmaBackgroundBlur.aex")),
            "binary_sha256": sha256(os.path.join(DELIV, "FigmaBackgroundBlur.aex")),
            "built_with": "After Effects SDK 27.0 (Windows) + MSVC 19.44 (v143) + MSBuild (x64)",
            "host_tested": "After Effects 2026 (26.0x67), Windows x64, 8 bpc, zh_CN UI",
            "workflow": "effect on an adjustment layer; the 形状图层 (layer param) alpha channel defines the blur region",
        },
        "algorithm": {
            "kernel": "separable triangular (Bartlett): w(k)=max(0, R-|k|), normalized by the used-weight sum",
            "clamp": "clamped to the shape layer's alpha bounding box, weights renormalized (Figma clamp)",
            "region": "the selected shape layer's alpha channel (silhouette) decides where the blurred backdrop is composited",
            "composite": "hard Figma discard (default) or soft coverage blend",
            "radius_meaning": "R in composition pixels, equals Figma's background blur radius at 1:1",
            "performance": {
                "implementation": "O(1)/pixel prefix-sum evaluation",
                "multi_frame_rendering": "PF_OutFlag2_SUPPORTS_THREADED_RENDERING; stateless render",
                "demo_render": {
                    "frames": 150,
                    "resolution": "1200x800",
                    "total_seconds": 7.97,
                    "ms_per_frame_approx": 53,
                },
            },
            "parameters_zh": ["背景模糊半径 (px)", "柔化边缘 (AA)", "形状图层（Alpha）", "显示遮罩 (调试)"],
        },
        "ab_vs_figma": {
            "figma_source": "figma_original.png (1200x800, background blur R=40, Figma frame 505:1200)",
            "regions": stats,
            "diff_image": diff,
        },
        "demo_video": {
            "file": "FigmaBackgroundBlurPlugin_Demo.mp4",
            "comp": "DEMO_AlphaLayer_Moving",
            "codec": "H.264 (libx264, yuv420p, crf16, faststart)",
            "size": "1200x800",
            "fps": 30,
            "frames": 150,
            "duration_s": 5.0,
            "file_bytes": os.path.getsize(os.path.join(DELIV, "FigmaBackgroundBlurPlugin_Demo.mp4")),
            "source": "150 frames rendered by AE (plugin region follows the animated card layer alpha), encoded with ffmpeg",
        },
        "ae_project": {
            "file": "FigmaBackgroundBlurPlugin_Demo.aep",
            "comps": ["DEMO_AlphaLayer_Moving", "AB_AlphaLayer", "REF_Figma_Original", "CMP_Figma_vs_AE"],
        },
        "provenance": {
            "figma_ab_scene": "Figma file (车牌-甲壳虫1124), page 'AE_背景模糊对照', frame 505:1200 'BGBlur_AB_1200x800' (kept)",
            "sdk": "After Effects SDK 27.0 (Windows), workspace copy ae-plugin/sdk/AfterEffectsSDK_27.0_win",
            "design_change": "v1.3 replaces the v1.2 fixed shape parameters with a shape-layer alpha reference "
                             "(AE effect filters cannot read the mask of their own adjustment layer).",
        },
        "notes": [
            "AE gives adjustment-layer effects the composite below with alpha=1, so the host layer's own mask is not visible "
            "to the effect. The v1.3 workflow therefore reads a chosen layer's alpha (shape layer / card layer / matte layer).",
            "Animated masks, track mattes and transforms on the shape layer all animate the blur region.",
            "Hard edge = Figma-faithful discard; Soft AA blends by coverage.",
            "Figma internally downsamples for radii > 4 texels (~2-4% narrower measured kernel); this plug-in computes the exact kernel.",
        ],
    }

    with open(os.path.join(DELIV, "fidelity_metrics.json"), "w", encoding="utf-8") as fp:
        json.dump(out, fp, indent=2, ensure_ascii=False)

    print(json.dumps({"stats": stats, "diff": diff, "sha": out["plugin"]["binary_sha256"]}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
